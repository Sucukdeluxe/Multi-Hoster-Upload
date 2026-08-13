const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createUploadStartReservation } = require('../lib/upload-start-reservation');

test('only one upload start can hold the reservation across asynchronous work', () => {
  const reservation = createUploadStartReservation();
  const first = reservation.acquire();

  assert.ok(first);
  assert.equal(reservation.isActive(), true);
  assert.equal(reservation.acquire(), null);

  first.release();
  const second = reservation.acquire();
  assert.ok(second);
  assert.notStrictEqual(second, first);
});

test('cancelling a reserved start is visible until its owner releases it', () => {
  const reservation = createUploadStartReservation();
  const lease = reservation.acquire();

  assert.equal(reservation.cancel(), true);
  assert.equal(lease.isCancelled(), true);
  assert.equal(reservation.acquire(), null);
  lease.release();
  assert.equal(reservation.isActive(), false);
  assert.equal(reservation.cancel(), false);
});

test('stale and repeated releases cannot clear a newer reservation', () => {
  const reservation = createUploadStartReservation();
  const first = reservation.acquire();
  first.release();
  const second = reservation.acquire();

  first.release();
  assert.equal(reservation.isActive(), true);
  assert.equal(reservation.acquire(), null);
  second.release();
  assert.equal(reservation.isActive(), false);
});

test('main process reserves starts before audit and exposes cancellation during the wait', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.slice(
    source.indexOf("ipcMain.handle('start-upload'"),
    source.indexOf("ipcMain.handle('cancel-selected-jobs'")
  );

  assert.ok(start.indexOf('uploadStartReservation.acquire()') < start.indexOf('appendUploadPlanAudit(batchPlan'));
  assert.match(start, /executeReservedUploadStart\(payload, startLease\)\.finally\(\(\) => startLease\.release\(\)\)/);
  assert.match(start, /uploadStartReservation\.cancel\(\)/);
  assert.match(source, /createSettingsImportGate\(\(\) => !!uploadManager \|\| uploadStartReservation\.isActive\(\)\)/);
});
