@echo off
setlocal
pushd "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call cmd /c npm install
  if errorlevel 1 (
    echo npm install failed.
    popd
    pause
    exit /b 1
  )
)

echo Starting AI Screenshot Tool...
call cmd /c npm run dev

popd
endlocal
