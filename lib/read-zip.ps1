param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [string]$Member
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  if (!$PSBoundParameters.ContainsKey('Member')) {
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    ConvertTo-Json -InputObject $names -Compress
  } else {
    $entries = @($zip.Entries | Where-Object { $_.FullName -ceq $Member })
    if ($entries.Count -ne 1) { throw 'Missing or ambiguous ZIP executable.' }
    $entry = $entries[0]
    if ($entry.Length -le 0 -or $entry.Length -gt 268435456) { throw 'Invalid executable size.' }
    $kind = ($entry.ExternalAttributes -shr 16) -band 61440
    if ($kind -ne 0 -and $kind -ne 32768) { throw 'ZIP executable is not a regular file.' }
    $inputStream = $entry.Open()
    try {
      $outputStream = [Console]::OpenStandardOutput()
      $buffer = New-Object byte[] 65536
      $length = 0L
      while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $length += $count
        if ($length -gt $entry.Length) { throw 'Invalid ZIP executable length.' }
        $outputStream.Write($buffer, 0, $count)
      }
      if ($length -ne $entry.Length) { throw 'Truncated ZIP executable.' }
      $outputStream.Flush()
    } finally { $inputStream.Dispose() }
  }
} finally { $zip.Dispose() }
