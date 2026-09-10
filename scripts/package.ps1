param([string]$GitPath = 'git', [string]$Version = 'v1.0.0-spectroid.1')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repo 'artifacts'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$archive = Join-Path $output "neon-noise-$Version.zip"
if (Test-Path -LiteralPath $archive) { throw 'Archive exists; use a new version or inspect the existing artifact.' }
$gitArgs = @('-c',"safe.directory=$($repo.Replace('\','/'))",'-C',$repo)
$head = & $GitPath @gitArgs rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read HEAD' }
& $GitPath @gitArgs archive --format=zip --prefix=neon-noise/ -o $archive HEAD
if ($LASTEXITCODE -ne 0) { throw 'Archive failed' }
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $licenseEntry = $zip.GetEntry('neon-noise/LICENSE')
  $htmlEntry = $zip.GetEntry('neon-noise/index.html')
  foreach ($required in @('README.md','CHANGELOG.md','docs/validation.md','tests/analysis.cjs')) {
    if (-not $zip.GetEntry("neon-noise/$required")) { throw "Missing $required" }
  }
  if (-not $licenseEntry -or -not $htmlEntry) { throw 'Missing application or license' }
  $reader = [IO.StreamReader]::new($licenseEntry.Open(),[Text.Encoding]::UTF8)
  try { $license = $reader.ReadToEnd().Trim() } finally { $reader.Dispose() }
  $reader = [IO.StreamReader]::new($htmlEntry.Open(),[Text.Encoding]::UTF8)
  try { $html = $reader.ReadToEnd() } finally { $reader.Dispose() }
  if (-not $html.Contains($license)) { throw 'Standalone HTML lacks complete license' }
  $entries = @($zip.Entries | Where-Object { $_.Name } | ForEach-Object {
    $stream = $_.Open()
    try { $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) }
    finally { $stream.Dispose() }
    [ordered]@{path=$_.FullName;bytes=$_.Length;sha256=$digest}
  })
} finally { $zip.Dispose() }
$receipt = [ordered]@{version=$Version;commit=$head;archive=[IO.Path]::GetFileName($archive);sha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash;entries=$entries}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$archive.manifest.json" -Encoding utf8
$receipt | ConvertTo-Json -Depth 5
