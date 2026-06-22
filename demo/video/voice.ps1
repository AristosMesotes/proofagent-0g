# voice.ps1 - generate a WAV voiceover from text using the built-in Windows SAPI engine.
# Usage: powershell -ExecutionPolicy Bypass -File voice.ps1 -TextFile in.txt -Out out.wav -Rate 0 -Voice "Microsoft David Desktop"
param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Rate = 0,
  [string]$Voice = "Microsoft David Desktop"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice($Voice) } catch { }   # fall back to default voice if not present
$s.Rate = $Rate
$s.Volume = 100
$s.SetOutputToWaveFile($Out)
$s.Speak($text)
$s.Dispose()
Write-Output "ok: $Out"
