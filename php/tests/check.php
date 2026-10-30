<?php
// NETLIFY=true VALLKEY_ENV=preview php -d extension=modules/vallkey.so tests/check.php
// Checks the extension with plain curl against two local servers (php -S), "vallkey" and
// "provider", which say who answered. Exits 1 on a failed transport assertion.
$ghost = implode('_', ['gk', 'openai', 'A1b2C3d4E5f6G7h8I9j0Kl', 'M1n2O3p4Q5r6S7t8U9v0Wx1Y2z3A4b5C6d7E8f9G0hI']);
$dir = sys_get_temp_dir() . '/vallkey-check-' . getmypid();
@mkdir($dir);
file_put_contents("$dir/router.php", '<?php
$name = getenv("SERVER_NAME_FOR_TEST");
$seen = ["server" => $name, "method" => $_SERVER["REQUEST_METHOD"], "path" => $_SERVER["REQUEST_URI"], "from" => $_SERVER["HTTP_X_VALLKEY_HOST"] ?? null, "hook" => $_SERVER["HTTP_X_VALLKEY_HOOK"] ?? null, "host" => $_SERVER["HTTP_HOST"] ?? null, "body" => file_get_contents("php://input")];
file_put_contents(getenv("SEEN_FILE"), json_encode($seen) . "\n", FILE_APPEND);
header("content-type: application/json");
echo json_encode(["from" => $name]);
');
$servers = [];
foreach (['vallkey' => 18571, 'provider' => 18572] as $name => $port) {
    $servers[] = proc_open([PHP_BINARY, '-n', '-S', "127.0.0.1:$port", "$dir/router.php"], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, null, ['SERVER_NAME_FOR_TEST' => $name, 'SEEN_FILE' => "$dir/seen.jsonl"]);
}
usleep(500000);
putenv('VALLKEY_API=http://127.0.0.1:18571');
$failures = 0;
function check($what, $ok) { global $failures; echo ($ok ? 'ok   ' : 'FAIL ') . "$what\n"; if (!$ok) $failures++; }
function last() { global $dir; $lines = file("$dir/seen.jsonl"); return json_decode(end($lines), true); }
function from($ch) { $out = curl_exec($ch); return json_decode((string) $out, true)['from'] ?? null; }

$ch = curl_init('http://api.openai.com/v1/chat/completions?x=1');
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_POSTFIELDS => '{"model":"m"}', CURLOPT_HTTPHEADER => ["Authorization: Bearer $ghost", 'Content-Type: application/json', 'Host: api.openai.com']]);
check('a ghost key in Authorization goes to Vallkey', from($ch) === 'vallkey');
$l = last();
check('path, query, body and the address it was for are kept', $l['method'] === 'POST' && $l['path'] === '/v1/chat/completions?x=1' && $l['body'] === '{"model":"m"}' && $l['from'] === 'api.openai.com' && $l['host'] === '127.0.0.1:18571');

check('it says what sent the request', $l['hook'] === 'php/0.1.0; runtime=' . PHP_VERSION . '; platform=netlify; env=preview');

$ch = curl_init('http://127.0.0.1:18572/plain');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Authorization: Bearer sk-real']);
check('a request without a ghost key is left alone', from($ch) === 'provider');

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, 'http://api.twilio.com/2010-04-01/Accounts.json');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_USERPWD, "AC1:$ghost");
check('a ghost key in CURLOPT_USERPWD goes to Vallkey', from($ch) === 'vallkey');

$ch = curl_init('http://api.example.com/basic');
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ['Authorization: Basic ' . base64_encode("user:$ghost")]]);
check('a ghost key in a Basic header goes to Vallkey', from($ch) === 'vallkey');

$ch = curl_init("http://generativelanguage.googleapis.com/v1beta/models?key=$ghost");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
check('a ghost key in the query goes to Vallkey', from($ch) === 'vallkey');

$copy = curl_copy_handle($ch);
check('a copied handle goes too', from($copy) === 'vallkey');

$mh = curl_multi_init();
$a = curl_init('http://api.anthropic.com/v1/messages');
curl_setopt_array($a, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ["x-api-key: $ghost"]]);
$b = curl_init('http://127.0.0.1:18572/multi');
curl_setopt($b, CURLOPT_RETURNTRANSFER, true);
curl_multi_add_handle($mh, $a);
curl_multi_add_handle($mh, $b);
do { curl_multi_exec($mh, $running); curl_multi_select($mh, 0.1); } while ($running);
check('curl_multi: a ghost key goes to Vallkey, the other request stays', json_decode(curl_multi_getcontent($a), true)['from'] === 'vallkey' && json_decode(curl_multi_getcontent($b), true)['from'] === 'provider');

$debugCode = <<<'PHP'
$c = curl_init('http://provider.example.invalid/sensitive-path-value?secret=private-query');
curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 5, CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('TEST_GHOST')]]);
echo curl_exec($c);
PHP;
$child = proc_open([PHP_BINARY, '-d', 'extension=' . realpath(__DIR__ . '/../modules/vallkey.so'), '-r', $debugCode],
    [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null,
    ['VALLKEY_API' => 'http://127.0.0.1:18571', 'VALLKEY_DEBUG' => '1', 'TEST_GHOST' => $ghost]);
$debugBody = stream_get_contents($pipes[1]);
$debugLog = stream_get_contents($pipes[2]);
fclose($pipes[1]);
fclose($pipes[2]);
$debugExit = proc_close($child);
check('debug requests still route', $debugExit === 0 && json_decode($debugBody, true)['from'] === 'vallkey');
check('debug logs omit paths, queries and credentials', str_contains($debugLog, 'http://provider.example.invalid ->') && !str_contains($debugLog, 'sensitive-path-value') && !str_contains($debugLog, 'private-query') && !str_contains($debugLog, $ghost));

foreach ($servers as $s) proc_terminate($s);
array_map('unlink', glob("$dir/*"));
rmdir($dir);
exit($failures ? 1 : 0);
