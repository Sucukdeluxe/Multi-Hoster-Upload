const { generateKeyPairSync } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { recoverBackupKey } = require('../lib/online-backup-recovery');

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init' && args.length === 1) {
    const directory = path.resolve(args[0]);
    await mkdir(directory, { mode: 0o700 });
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    await writeFile(path.join(directory, 'recovery-private.pem'), pair.privateKey, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(directory, 'recovery-public.pem'), pair.publicKey, { flag: 'wx', mode: 0o600 });
    process.stdout.write('Schlüsselpaar erstellt. Private Datei separat sichern; nur die öffentliche Datei auf den Server übertragen.\n');
    return;
  }
  if (command === 'recover' && args.length === 3) {
    const [recordFile, privateFile, outputFile] = args.map(value => path.resolve(value));
    const id = path.basename(recordFile, '.json');
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new Error('Der Datensatz muss seinen ursprünglichen Dateinamen behalten');
    const record = JSON.parse(await readFile(recordFile, 'utf8'));
    const key = recoverBackupKey(id, record, await readFile(privateFile, 'utf8'));
    await writeFile(outputFile, `${key}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write('Online-Schlüssel in der angegebenen Ausgabedatei gespeichert.\n');
    return;
  }
  throw new Error('Aufruf: node scripts/backup-recovery.cjs init <neuer-Ordner> | recover <Datensatz.json> <private.pem> <neue-Ausgabedatei>');
}

main().catch(() => {
  process.stderr.write('Wiederherstellung fehlgeschlagen. Aufruf, Dateipfade, Ablaufdatum und Schlüsselzuordnung prüfen. Vorhandene Dateien werden nicht überschrieben.\n');
  process.exitCode = 1;
});
