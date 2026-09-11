const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
function assertPrivateFile(filename) {
    assert.ok(fs.statSync(filename).isFile());
    if(process.platform!=='win32'){assert.equal(fs.statSync(filename).mode&0o777,0o600);return;}
    const encodedPath=Buffer.from(filename,'utf8').toString('base64');
    const script=`$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));$who=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($who,'S-1-5-18','S-1-5-32-544');$bad=@((Get-Acl -LiteralPath $p).Access | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed} | ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value});ConvertTo-Json -Compress -InputObject @{private=($bad.Count -eq 0);unexpected=$bad}`;
    const result=execFileSync(require('node:path').join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000});
    const acl=JSON.parse(result.replace(/^\uFEFF/,''));assert.equal(acl.private,true,'Unexpected access to private file: '+acl.unexpected.join(','));
}
module.exports={assertPrivateFile};
