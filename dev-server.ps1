# Local static server for testing the app on http://localhost:8000
# (service workers and Google sign-in do not work from a file:// path).
#   powershell -ExecutionPolicy Bypass -File dev-server.ps1
# Stop it with Ctrl+C.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$prefix = 'http://localhost:8000/'

$mime = @{
    '.html'        = 'text/html; charset=utf-8'
    '.js'          = 'text/javascript; charset=utf-8'
    '.css'         = 'text/css; charset=utf-8'
    '.json'        = 'application/json; charset=utf-8'
    '.webmanifest' = 'application/manifest+json; charset=utf-8'
    '.png'         = 'image/png'
    '.svg'         = 'image/svg+xml'
    '.md'          = 'text/markdown; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Output "serving $root at $prefix"

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $path = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
    if ($path -eq '/' -or $path.EndsWith('/')) { $path = $path + 'index.html' }
    $file = Join-Path $root ($path.TrimStart('/') -replace '/', '\')

    if (Test-Path -LiteralPath $file -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($file).ToLower()
        $type = $mime[$ext]
        if (-not $type) { $type = 'application/octet-stream' }
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $context.Response.ContentType = $type
        $context.Response.Headers.Add('Cache-Control', 'no-store')
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        Write-Output "200 $path"
    } else {
        $context.Response.StatusCode = 404
        Write-Output "404 $path"
    }
    $context.Response.Close()
}
