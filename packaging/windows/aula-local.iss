; Instalador de aula-local (Inno Setup 6). Lo invoca scripts/package-win.mjs con /D para pasar:
; AppVersion, StageDir (carpeta de staging con los archivos) y OutputDir (donde se escribe el .exe).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #error Falta /DStageDir=<carpeta stage>. Usa npm run package:win.
#endif
#ifndef OutputDir
  #error Falta /DOutputDir=<carpeta de salida>. Usa npm run package:win.
#endif

[Setup]
; AppId fijo: identifica la aplicación entre versiones. No cambiarlo.
AppId={{c21cd5ae-7d43-4902-a4ac-feb266cba16f}
AppName=aula-local
AppVersion={#AppVersion}
AppVerName=aula-local {#AppVersion}
AppPublisher=aula-local
DefaultDirName={autopf}\aula-local
DefaultGroupName=aula-local
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=aula-local-setup-{#AppVersion}
SetupIconFile={#StageDir}\aula-local.ico
UninstallDisplayIcon={app}\aula-local.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Cierra el lanzador si sigue abierto durante una actualización.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Messages]
es.FinishedLabel=aula-local quedó instalado. Al abrirlo aparecerá un icono junto al reloj (bandeja del sistema); desde ahí abres "Mis clases".

[Tasks]
Name: "desktopicon"; Description: "Crear un acceso directo en el escritorio"; GroupDescription: "Accesos directos:"; Flags: checkedonce

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\aula-local"; Filename: "{app}\aula-local.exe"; WorkingDir: "{app}"; IconFilename: "{app}\aula-local.ico"
Name: "{autodesktop}\aula-local"; Filename: "{app}\aula-local.exe"; WorkingDir: "{app}"; IconFilename: "{app}\aula-local.ico"; Tasks: desktopicon

[Run]
; Regla de firewall solo para redes privadas: la anterior se borra para no dejar duplicados.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""aula-local"""; Flags: runhidden waituntilterminated; StatusMsg: "Configurando el firewall de Windows (redes privadas)..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""aula-local"" dir=in action=allow program=""{app}\node\node.exe"" enable=yes profile=private"; Flags: runhidden waituntilterminated; StatusMsg: "Configurando el firewall de Windows (redes privadas)..."
Filename: "{app}\aula-local.exe"; Description: "Iniciar aula-local"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Primero se detiene el servidor (el lanzador lo apaga), después se quita la regla del firewall.
Filename: "{app}\aula-local.exe"; Parameters: "--salir"; Flags: runhidden waituntilterminated; RunOnceId: "StopApp"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""aula-local"""; Flags: runhidden waituntilterminated; RunOnceId: "DelFw"

[Code]
// Detiene una instancia anterior antes de copiar archivos, para no bloquear los .exe y .dll en la actualización.
procedure DetenerVersionAnterior();
var
  Codigo: Integer;
  Lanzador: String;
begin
  Lanzador := ExpandConstant('{app}\aula-local.exe');
  if FileExists(Lanzador) then
    Exec(Lanzador, '--salir', '', SW_HIDE, ewWaitUntilTerminated, Codigo);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    DetenerVersionAnterior();
end;

// Los datos del usuario no se borran al desinstalar: se avisa dónde quedaron.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent) then
    MsgBox('Tus clases se conservaron en:' + #13#10 +
      ExpandConstant('{localappdata}\aula-local') + #13#10#13#10 +
      'Si ya no las necesitas, puedes borrar esa carpeta.', mbInformation, MB_OK);
end;
