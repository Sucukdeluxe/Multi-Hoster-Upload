const { generateKeyPairSync } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { isIP } = require('node:net');
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
  if (command === 'recover' && (args.length === 3 || (args.length === 4 && args[3] === '--details'))) {
    const [recordFile, privateFile, outputFile] = args.slice(0, 3).map(value => path.resolve(value));
    const id = path.basename(recordFile, '.json');
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new Error('Der Datensatz muss seinen ursprünglichen Dateinamen behalten');
    const record = JSON.parse(await readFile(recordFile, 'utf8'));
    const key = recoverBackupKey(id, record, await readFile(privateFile, 'utf8'));
    let output = key;
    if (args[3] === '--details') {
      const date = new Date(record.createdAt);
      if (!Number.isFinite(date.getTime())) throw new Error('Invalid creation date');
      const formatted = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date).replace(', ', ' - ');
      const sourceIp = typeof record.sourceIp === 'string' && isIP(record.sourceIp) ? record.sourceIp : 'unbekannt';
      output = `${formatted} | IP: ${sourceIp} | ${key}`;
    }
    await writeFile(outputFile, `${output}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write('Online-Schlüssel in der angegebenen Ausgabedatei gespeichert.\n');
    return;
  }
  throw new Error('Aufruf: node scripts/backup-recovery.cjs init <neuer-Ordner> | recover <Datensatz.json> <private.pem> <neue-Ausgabedatei> [--details]');
}

main().catch(() => {
  process.stderr.write('Wiederherstellung fehlgeschlagen. Aufruf, Dateipfade, Ablaufdatum und Schlüsselzuordnung prüfen. Vorhandene Dateien werden nicht überschrieben.\n');
  process.exitCode = 1;
});
