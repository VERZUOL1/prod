@echo off
setlocal enabledelayedexpansion

echo Administrative permissions required. Detecting permissions...

net session >nul 2>&1
if %errorLevel% NEQ 0 (
  set ERROR_MSG=Failure: Current permissions inadequate.
	goto fail
)
echo Success: Administrative permissions confirmed.

set appcmd=%systemroot%\system32\inetsrv\appcmd.exe
set icacls=%systemroot%\system32\icacls.exe
set site=FPO2.0
set www=C:\inetpub\apps\fpo2
set root=%www%
set webconfig=%root%\iis\web.config
set backend=%root%\back-end
set frontend=%root%\front-end
set package=%root%\tmp\deployment

if not exist "%icacls%" (
	set ERROR_MSG=Installation failed. The icacls.exe not found at %icacls%.
	goto fail
)

if not exist %appcmd% (
	set ERROR_MSG=Installation failed. The appcmd.exe IIS management tool was not found at %appcmd%. Make sure you have both IIS7 as well as IIS7 Management Tools installed.
	goto fail
)


echo Creating deployment package...
cd %root%
if exist %package% rmdir /s /q %package%

mkdir %package%

xcopy /s/e/i/z %backend% %package%\app
xcopy /s/e/i/z %frontend%\dist %package%\app\dist
echo Done...

echo Building backend...
cd %package%\app
call npm cache verify
call npm install
if %ERRORLEVEL% neq 0 (
	set ERROR_MSG=Could not build backend module.
	goto fail
)
echo Done...

xcopy /s/e/i/y %webconfig% %www%

echo Stopping %site% site...
%appcmd% stop site %site%
if %ERRORLEVEL% neq 0 if %ERRORLEVEL% neq 50 (
	set ERROR_MSG=Installation failed. Unable to stop %site% site.
	goto fail
)
echo Done...

echo Updating %site% site files...
if exist %www%\app rmdir /s/q %www%\app
xcopy /s/e/i %package%\app %www%\app
echo Done...

echo Ensuring IIS_IUSRS group has full permissions for "%www%"...
%icacls% "%www%" /grant IIS_IUSRS:(OI)(CI)F
if %ERRORLEVEL% neq 0 (
	set ERROR_MSG=Installation failed. Unable to set permissions for %www%.
	goto fail
)
echo Done...

echo Starting %site% site...
%appcmd% start site %site%
if %ERRORLEVEL% neq 0 if %ERRORLEVEL% neq 50 (
	set ERROR_MSG=Installation failed. Unable to start %site% site.
	goto fail
)
echo Done...
call npm cache verify
echo.
echo Script successfully finished!

goto :EOF
:fail
	echo %ERROR_MSG%
	exit /b -1
