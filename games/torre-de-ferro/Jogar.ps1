$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms

$gameDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$porta = 8099
$url = "http://127.0.0.1:$porta/"

function Test-Jogo {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (-not (Test-Jogo)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show(
      "Node.js nao encontrado neste PC.`n`nInstale o Node.js 18+ (gratuito, nodejs.org) ou use a versao publicada em:`nhttps://dshsuperagent-oss.github.io/superagent-sandbox/",
      'Torre de Ferro', 'OK', 'Warning') | Out-Null
    exit 1
  }
  Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', "title Torre de Ferro - servidor (feche esta janela para parar) && node serve.mjs $porta" `
    -WorkingDirectory $gameDir -WindowStyle Minimized
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 300
    if (Test-Jogo) { break }
  }
}

if (Test-Jogo) {
  Start-Process $url
} else {
  [System.Windows.Forms.MessageBox]::Show(
    "O servidor do jogo nao respondeu na porta $porta.`n`nFeche outras janelas do Torre de Ferro e tente de novo.`nSe o problema continuar, o jogo tambem roda online em:`nhttps://dshsuperagent-oss.github.io/superagent-sandbox/",
    'Torre de Ferro', 'OK', 'Error') | Out-Null
}
