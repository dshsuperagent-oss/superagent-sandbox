# test-parse.ps1 - analisador do PowerShell em todos os .ps1 + frontmatter do SKILL.md.
#
# Tambem verifica:
#   - todos os .ps1 em ASCII puro (PS 5.1 le arquivo sem BOM como ANSI);
#   - frontmatter name/description do SKILL.md;
#   - presenca dos arquivos obrigatorios da skill.
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\skills\dsh-maintenance\tests\test-parse.ps1

[CmdletBinding()]
param(
    [string]$SkillRoot = ''
)

$ErrorActionPreference = 'Continue'
if (-not $SkillRoot) { $SkillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$falhas = @()

Write-Host '== 1. parser do PowerShell (PS ' + $PSVersionTable.PSVersion + ') =='
$ps1 = @(Get-ChildItem -LiteralPath $SkillRoot -Recurse -Filter '*.ps1' -File | Sort-Object FullName)
foreach ($f in $ps1) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count -eq 0) {
        Write-Host ('OK   ' + $f.FullName.Substring($SkillRoot.Length + 1) + ' (' + $tokens.Count + ' tokens)')
    } else {
        Write-Host ('FAIL ' + $f.FullName.Substring($SkillRoot.Length + 1))
        foreach ($e in $errors) { Write-Host ('     linha ' + $e.Extent.StartLineNumber + ': ' + $e.Message) }
        $falhas += ('parse: ' + $f.Name)
    }
}

Write-Host ''
Write-Host '== 2. ASCII puro nos .ps1 =='
foreach ($f in $ps1) {
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $bad = 0
    foreach ($b in $bytes) { if ($b -gt 127) { $bad++; break } }
    if ($bad -eq 0) { Write-Host ('OK   ' + $f.Name) } else { Write-Host ('FAIL ' + $f.Name + ' tem byte > 127'); $falhas += ('ascii: ' + $f.Name) }
}

Write-Host ''
Write-Host '== 3. frontmatter do SKILL.md =='
$skill = Join-Path $SkillRoot 'SKILL.md'
if (-not (Test-Path -LiteralPath $skill)) {
    $falhas += 'SKILL.md ausente'
} else {
    $lines = @(Get-Content -LiteralPath $skill -TotalCount 20)
    if ($lines.Count -lt 4 -or $lines[0].Trim() -ne '---') { $falhas += 'SKILL.md sem --- inicial' }
    $end = -1
    for ($i = 1; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim() -eq '---') { $end = $i; break } }
    if ($end -lt 0) { $falhas += 'SKILL.md sem --- final do frontmatter' }
    $nameLine = @($lines | Where-Object { $_ -match '^name:\s*\S+' })
    $descLine = @($lines | Where-Object { $_ -match '^description:\s*\S+' })
    if ($nameLine.Count -ne 1) { $falhas += 'frontmatter name ausente/duplicado' }
    elseif ($nameLine[0] -notmatch '^name:\s*dsh-maintenance\s*$') { $falhas += ('name inesperado: ' + $nameLine[0]) }
    if ($descLine.Count -ne 1) { $falhas += 'frontmatter description ausente/duplicado' }
    Write-Host ('OK   name: ' + ($nameLine -join ' '))
    Write-Host ('OK   description: ' + (($descLine -join ' ').Substring(0, [Math]::Min(120, ($descLine -join ' ').Length))) + '...')
}

Write-Host ''
Write-Host '== 4. arquivos obrigatorios =='
$required = @(
    'SKILL.md',
    'README.md',
    'install.ps1',
    'uninstall.ps1',
    'scripts\observador.ps1',
    'scripts\captura.ps1',
    'scripts\supervisor-dsh.ps1',
    'scripts\supervisor-observador.ps1',
    'scripts\supervisor-runner.ps1',
    'scripts\lib.ps1',
    'tests\test-captura-killer.ps1',
    'tests\test-captura-curta.ps1',
    'tests\test-captura-taskkill-real.ps1',
    'tests\test-disco.ps1',
    'tests\test-supervisor.ps1',
    'tests\test-rotacao.ps1',
    'tests\test-install.ps1',
    'tests\test-hung.ps1',
    'tests\test-parse.ps1'
)
foreach ($rel in $required) {
    $p = Join-Path $SkillRoot $rel
    if (Test-Path -LiteralPath $p) { Write-Host ('OK   ' + $rel) } else { Write-Host ('FAIL ' + $rel); $falhas += ('ausente: ' + $rel) }
}

Write-Host ''
if ($falhas.Count -eq 0) {
    Write-Host 'RESULTADO: PASS - todos os .ps1 parseiam, ASCII puro, frontmatter e arquivos obrigatorios OK.'
    exit 0
} else {
    Write-Host ('RESULTADO: FAIL - ' + ($falhas -join '; '))
    exit 1
}
