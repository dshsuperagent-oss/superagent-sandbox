@echo off
setlocal
title Torre de Ferro - Iniciar
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ============================================================
  echo  Node.js nao encontrado neste PC.
  echo  O jogo roda com Node.js 18 ou superior ^(gratuito, nodejs.org^).
  echo  Se o servidor ja estiver rodando, abra: http://127.0.0.1:8150/
  echo ============================================================
  pause
  exit /b 1
)
echo Iniciando o servidor do Torre de Ferro...
start "Torre de Ferro - servidor (feche esta janela para parar)" /min cmd /c "node serve.mjs 8099"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8099/"
endlocal
