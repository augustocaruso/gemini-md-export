@echo off
chcp 65001 >nul 2>&1
setlocal ENABLEEXTENSIONS ENABLEDELAYEDEXPANSION

cd /d "%~dp0"

echo.
echo ============================================================
echo   Gemini -^> Markdown Export   ^|   Instalador Windows
echo ============================================================
echo.

REM --- Detecta execucao de dentro do zip ---------------------
REM Quando o usuario da duplo-clique no .cmd dentro do zip sem
REM extrair, o Windows Explorer monta um path temporario
REM ...\AppData\Local\Temp\<GUID>\...zip.<suffix>\ e os arquivos
REM irmaos (scripts\, src\, package.json) nao aparecem.
REM Tambem ocorre em previews zip de email/OneDrive.

echo %~dp0 | find /I "\AppData\Local\Temp\" >nul
if not errorlevel 1 goto :zip_not_extracted

if not exist "%~dp0scripts\install-windows.mjs" goto :missing_siblings
if not exist "%~dp0package.json" goto :missing_siblings
if exist "%~dp0src\mcp-server.js" goto :check_node
if exist "%~dp0dist\gemini-cli-extension\src\mcp-server.js" goto :check_node

goto :check_node

:zip_not_extracted
echo [ERRO] Voce esta rodando o install-windows.cmd direto de
echo        dentro do zip (o Windows abriu o zip como pasta).
echo.
echo   Caminho detectado:
echo     %~dp0
echo.
echo   O que fazer:
echo     1. Feche esta janela.
echo     2. No Explorador de Arquivos, clique com botao direito
echo        no arquivo gemini-md-export-windows-*.zip.
echo     3. Escolha "Extrair tudo..." e confirme.
echo     4. Entre na pasta extraida (NAO no zip) e de duplo
echo        clique em install-windows.cmd dali.
echo.
pause
exit /b 1

:missing_siblings
echo [ERRO] Este install-windows.cmd esta isolado da pasta
echo        original. Arquivos necessarios nao foram
echo        encontrados ao lado dele.
echo.
echo   Pasta atual:
echo     %~dp0
echo.
echo   Esperado encontrar:
echo     %~dp0scripts\install-windows.mjs
echo     %~dp0package.json
echo     %~dp0src\mcp-server.js
echo        ou
echo     %~dp0dist\gemini-cli-extension\src\mcp-server.js
echo.
echo   O que fazer:
echo     Descompacte o zip inteiro em uma pasta normal
echo     (ex: C:\Users\%USERNAME%\Downloads\gemini-md-export)
echo     e rode o install-windows.cmd de dentro dessa pasta.
echo.
pause
exit /b 1

:check_node
echo Este instalador vai:
echo   1. Verificar se o Node.js esta presente
if exist "%~dp0dist\gemini-cli-extension\src\mcp-server.js" (
echo   2. Reaproveitar o payload precompilado deste pacote
echo      ^(sem npm install / npm run build^)
) else (
echo   2. Baixar dependencias (npm install)
echo   3. Compilar a extensao e o servidor MCP (npm run build)
)
echo   4. Localizar instalacao anterior, se ja existir
echo   5. Substituir extensao/MCP preservando backup curto
echo   6. Sincronizar extensao unpacked ja carregada no browser
echo   7. Configurar o Claude Desktop (se estiver instalado)
echo   8. Configurar o Gemini CLI (se estiver instalado)
echo   9. Abrir a pagina de extensoes do navegador para o passo final manual
echo.
echo O passo de carregar a extensao empacotada e manual por
echo restricao do Chrome/Edge (Load unpacked). O instalador
echo tenta abrir o executavel real do navegador e mostra
echo exatamente o que clicar no fim.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  echo.
  echo     Baixe e instale o Node.js 20 ou superior:
  echo         https://nodejs.org/pt-br/download
  echo.
  echo     Na instalacao do Node, mantenha a opcao "Add to PATH"
  echo     marcada. Depois feche esta janela e execute o instalador
  echo     novamente.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
echo Node.js detectado: !NODE_VERSION!
echo.
echo Iniciando instalacao. Isto pode levar 1-2 minutos na
echo primeira vez (download de dependencias).
echo.

if exist "%~dp0dist\gemini-cli-extension\src\mcp-server.js" (
  set "GEMINI_INSTALL_PREBUILT_PAYLOAD=1"
)

node scripts\install-windows.mjs --open-browser %*
set "INSTALL_EXIT=%ERRORLEVEL%"

set "GME_EXTENSION_PATH=%LOCALAPPDATA%\GeminiMdExport\extension"
set "GME_SUMMARY_PATH=%LOCALAPPDATA%\GeminiMdExport\INSTALL-SUMMARY.txt"
set "GME_LAST_INSTALL=%TEMP%\gemini-md-export-last-install.env"
if exist "%GME_LAST_INSTALL%" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%GME_LAST_INSTALL%") do (
    if /I "%%a"=="extensionPath" set "GME_EXTENSION_PATH=%%b"
    if /I "%%a"=="summaryPath" set "GME_SUMMARY_PATH=%%b"
  )
)

echo.
echo ============================================================
if not "%INSTALL_EXIT%"=="0" (
  echo   INSTALACAO FALHOU ^(codigo %INSTALL_EXIT%^)
  echo ============================================================
  echo.
  echo   Leia as mensagens acima. Causas comuns:
  echo     - Sem internet durante o npm install
  echo     - Antivirus bloqueando arquivos em AppData
  echo     - Node.js muito antigo ^(precisa ^>= 20^)
  echo.
  echo   Se nao conseguir resolver, envie um print desta janela
  echo   para quem te mandou o zip.
  echo.
) else (
  echo   INSTALACAO CONCLUIDA COM SUCESSO
  echo ============================================================
  echo.
  echo   Proximos passos:
echo     1. A pagina de extensoes do navegador deve ter aberto.
echo        Se nao abriu, abra manualmente.
echo     2. Ative "Modo do desenvolvedor" ^(canto superior direito^).
echo     3. Clique em "Carregar sem compactacao" / "Load unpacked".
echo     4. Selecione a pasta:
echo           !GME_EXTENSION_PATH!
echo        Se a extensao ja estava carregada, clique tambem no
echo        icone circular de reload do card da extensao, ou rode
echo        refresh-browser-extension.cmd na pasta instalada.
echo     5. Se o Gemini CLI estiver aberto, feche a sessao antiga
echo        e rode restart-gemini-cli.cmd na pasta instalada.
echo     6. Abra https://gemini.google.com/app em uma aba nova
echo        ^(ou rode open-gemini.cmd na pasta instalada^) e entre
echo        em uma conversa especifica ^(URL /app/^<id^>^).
echo     7. Na conversa, procure o botao de download no canto
echo        superior direito ^(ao lado do avatar^).
echo.
echo   Resumo completo salvo em:
echo     !GME_SUMMARY_PATH!
  echo.
)
pause
exit /b %INSTALL_EXIT%
