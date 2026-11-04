'use strict';

/**
 * Adapter entre o servidor e o Blender real (ou o fake-blender de fixtures).
 *
 * O processo filho é sempre invocado no mesmo formato:
 *
 *   blender -b --python-exit-code 1 -P build.py -- --spec ... --out ...
 *            --stage preview|final --preview-index N --progress-json
 *
 * e conversa por JSON Lines no stdout. Linhas que não são JSON (mensagens do
 * Blender, warnings, traceback) viram logs.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

function createRenderer(options = {}) {
  const {
    fake = false,
    blenderPath = 'blender',
    buildScript = path.join(__dirname, 'build.py'),
    fakeScript = path.join(__dirname, 'fake-blender.js'),
    timeoutMs = 30 * 60 * 1000,
  } = options;

  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();

  function commandAndArgs({ specPath, outDir, stage, previewIndex }) {
    const tail = [
      '--spec', specPath,
      '--out', outDir,
      '--stage', stage,
      '--preview-index', String(previewIndex),
      '--progress-json',
    ];
    if (fake) {
      return {
        command: process.execPath,
        args: ['-b', '-P', buildScript, '--', ...tail],
        display: `fake-blender (${path.basename(fakeScript)})`,
        fakeScript,
      };
    }
    return {
      command: blenderPath,
      args: ['-b', '--python-exit-code', '1', '-P', buildScript, '--', ...tail],
      display: blenderPath,
    };
  }

  /**
   * Executa uma etapa e resolve quando o processo termina.
   * Não rejeita em exit code != 0: o servidor decide a mensagem de erro
   * (assim ele consegue anexar o stderr ao log do job).
   *
   * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean, command:string}>}
   */
  function render({ specPath, outDir, stage = 'preview', previewIndex = 1, onEvent = () => {}, onLog = () => {} }) {
    const { command, args, display, fakeScript: scriptForFake } = commandAndArgs({ specPath, outDir, stage, previewIndex });
    const spawnArgs = fake ? [scriptForFake, ...args.slice(3)] : args;

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let timer = null;

      onLog('info', `executando ${display} (${stage}, preview #${previewIndex})`);
      if (process.env.BLENDER_DIRECTOR_DEBUG === '1') {
        onLog('info', `comando: ${command} ${spawnArgs.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
      }

      const child = spawn(command, spawnArgs, {
        cwd: outDir,
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);

      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        children.delete(child);
        clearTimeout(timer);
        if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);
        if (stderrBuffer.trim()) handleStderr(stderrBuffer);
        resolve({ code, signal, timedOut, command: display });
      };

      const handleStdoutLine = (rawLine) => {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line) return;
        if (line.startsWith('{') || line.startsWith('[')) {
          try {
            const payload = JSON.parse(line);
            if (payload && typeof payload === 'object') {
              try {
                onEvent(payload);
              } catch (error) {
                onLog('error', `falha ao processar evento do renderer: ${error.message}`);
              }
              return;
            }
          } catch {
            // não era JSON; cai no log abaixo
          }
        }
        onLog('stdout', line);
      };

      const handleStderr = (raw) => {
        for (const line of raw.split(/\r?\n/)) {
          if (line.trim()) onLog('stderr', line.trim());
        }
      };

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf8');
        let index = stdoutBuffer.indexOf('\n');
        while (index !== -1) {
          const line = stdoutBuffer.slice(0, index);
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          handleStdoutLine(line);
          index = stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString('utf8');
        let index = stderrBuffer.indexOf('\n');
        while (index !== -1) {
          const line = stderrBuffer.slice(0, index);
          stderrBuffer = stderrBuffer.slice(index + 1);
          if (line.trim()) onLog('stderr', line.trim());
        }
        // evita crescimento sem limite em renders longos
        if (stderrBuffer.length > 64 * 1024) stderrBuffer = stderrBuffer.slice(-32 * 1024);
      });

      child.on('error', (error) => {
        onLog('error', `não foi possível executar "${display}": ${error.message}`);
        finish(null, null);
      });

      child.on('close', (code, signal) => finish(code, signal));

      timer = setTimeout(() => {
        timedOut = true;
        onLog('error', `timeout de ${Math.round(timeoutMs / 1000)}s; encerrando ${display}`);
        child.kill('SIGKILL');
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  function describe() {
    return fake ? 'fake-blender (fixture)' : blenderPath;
  }

  function killAll() {
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // processo já terminou
      }
    }
    children.clear();
  }

  return { render, describe, killAll, fake, blenderPath };
}

module.exports = { createRenderer };
