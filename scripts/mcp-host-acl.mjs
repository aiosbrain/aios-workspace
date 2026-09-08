import { execFileSync } from "node:child_process";

// One OS read per snapshot, including every ancestor. Do not cache ACL results
// across snapshots: every transaction recheck must observe current permissions.
export function readWindowsHostAcls(files, exec = execFileSync) {
  const script =
    "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; " +
    "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
    "$rows=@(foreach($p in (ConvertFrom-Json $env:AIOS_MCP_ACL_PATHS)){ " +
    "$a=Get-Acl -LiteralPath $p; " +
    "$owner=([System.Security.Principal.NTAccount]$a.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value; " +
    "$allow=@($a.Access | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}); " +
    "@{path=$p;owner=$owner;current=$current;allow=$allow} }); ConvertTo-Json -InputObject $rows -Compress";
  const rows = JSON.parse(
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, AIOS_MCP_ACL_PATHS: JSON.stringify(files) },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    })
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== files.length ||
    rows.some((row, index) => row.path !== files[index])
  )
    throw new Error("Cannot verify Windows configuration ACLs");
  return new Map(rows.map((row) => [row.path, row]));
}
