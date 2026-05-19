/**
 * MVCC KV Store Tests
 * 
 * Tests for:
 * - Basic operations (begin, get, set, delete, commit, rollback)
 * - Snapshot isolation
 * - Read-your-own-writes
 * - Conflict detection
 * - Tombstone deletes
 * - Prefix scan
 * - WAL recovery
 * - Compaction
 */

const fs = require('fs');
const path = require('path');
const { MVCCStore } = require('./mvcc-store');

// Test utilities
let testCount = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  testCount++;
  if (condition) {
    passCount++;
    console.log(`✓ ${message}`);
  } else {
    failCount++;
    console.log(`✗ ${message}`);
  }
}

function assertEquals(actual, expected, message) {
  const condition = JSON.stringify(actual) === JSON.stringify(expected);
  assert(condition, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function cleanupWal(walPath) {
  if (fs.existsSync(walPath)) {
    fs.unlinkSync(walPath);
  }
}

// Test suite
async function runTests() {
  const walPath = './test-wal.log';
  
  console.log('\n=== MVCC KV Store Tests ===\n');

  // Clean up before tests
  cleanupWal(walPath);

  // ========== Basic Operations ==========
  console.log('--- Basic Operations ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Test begin and commit
    const tx1 = store.begin();
    assert(tx1 > 0, 'begin() returns positive txId');
    
    // Test set and get
    store.set(tx1, 'key1', 'value1');
    const result1 = store.get(tx1, 'key1');
    assertEquals(result1, { value: 'value1', found: true }, 'get() returns own write');
    
    // Test commit
    const committed = store.commit(tx1);
    assert(committed === true, 'commit() succeeds with no conflicts');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Snapshot Isolation ==========
  console.log('\n--- Snapshot Isolation ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Setup: TX1 commits a value
    const tx1 = store.begin();
    store.set(tx1, 'snapshot-key', 'initial');
    store.commit(tx1);
    
    // TX2 starts and reads the value
    const tx2 = store.begin();
    const result2 = store.get(tx2, 'snapshot-key');
    assertEquals(result2.value, 'initial', 'TX2 sees initial value');
    
    // TX3 modifies and commits
    const tx3 = store.begin();
    store.set(tx3, 'snapshot-key', 'modified-by-tx3');
    store.commit(tx3);
    
    // TX2 should still see the old value (snapshot isolation)
    const result2After = store.get(tx2, 'snapshot-key');
    assertEquals(result2After.value, 'initial', 'TX2 still sees snapshot value after TX3 commit');
    
    // New transaction sees new value
    const tx4 = store.begin();
    const result4 = store.get(tx4, 'snapshot-key');
    assertEquals(result4.value, 'modified-by-tx3', 'New transaction sees latest committed value');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Read Your Own Writes ==========
  console.log('\n--- Read Your Own Writes ---');
  
  {
    const store = new MVCCStore(walPath);
    
    const tx1 = store.begin();
    store.set(tx1, 'rowk', 'v1');
    
    // Should read own uncommitted write
    const result1 = store.get(tx1, 'rowk');
    assertEquals(result1, { value: 'v1', found: true }, 'Read own uncommitted write');
    
    // Overwrite in same transaction
    store.set(tx1, 'rowk', 'v2');
    const result2 = store.get(tx1, 'rowk');
    assertEquals(result2, { value: 'v2', found: true }, 'Read latest own write');
    
    store.rollback(tx1);
    store.close();
  }
  cleanupWal(walPath);

  // ========== Conflict Detection ==========
  console.log('\n--- Conflict Detection ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Setup: Initial value
    const txInit = store.begin();
    store.set(txInit, 'conflict-key', 'init');
    store.commit(txInit);
    
    // TX1 starts
    const tx1 = store.begin();
    
    // TX2 starts, modifies, and commits
    const tx2 = store.begin();
    store.set(tx2, 'conflict-key', 'tx2-value');
    const tx2Committed = store.commit(tx2);
    assert(tx2Committed === true, 'TX2 commits successfully');
    
    // TX1 tries to modify same key and commit
    store.set(tx1, 'conflict-key', 'tx1-value');
    const tx1Committed = store.commit(tx1);
    assert(tx1Committed === false, 'TX1 fails due to conflict');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Tombstone Deletes ==========
  console.log('\n--- Tombstone Deletes ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Setup
    const tx1 = store.begin();
    store.set(tx1, 'delete-key', 'exists');
    store.commit(tx1);
    
    // Delete in TX2
    const tx2 = store.begin();
    store.delete(tx2, 'delete-key');
    
    // Should not find deleted key
    const result2 = store.get(tx2, 'delete-key');
    assertEquals(result2, { value: null, found: false }, 'Deleted key not found in deleting tx');
    
    store.commit(tx2);
    
    // After commit, new tx should not find it
    const tx3 = store.begin();
    const result3 = store.get(tx3, 'delete-key');
    assertEquals(result3, { value: null, found: false }, 'Deleted key not found after commit');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Prefix Scan ==========
  console.log('\n--- Prefix Scan ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Setup data
    const tx1 = store.begin();
    store.set(tx1, 'user:1', 'alice');
    store.set(tx1, 'user:2', 'bob');
    store.set(tx1, 'user:3', 'charlie');
    store.set(tx1, 'order:1', 'order-a');
    store.commit(tx1);
    
    // Scan with prefix
    const tx2 = store.begin();
    const users = store.scan(tx2, 'user:');
    assertEquals(users.length, 3, 'Scan returns 3 user keys');
    assertEquals(users[0], { key: 'user:1', value: 'alice' }, 'First user is alice');
    assertEquals(users[1], { key: 'user:2', value: 'bob' }, 'Second user is bob');
    assertEquals(users[2], { key: 'user:3', value: 'charlie' }, 'Third user is charlie');
    
    // Scan with different prefix
    const orders = store.scan(tx2, 'order:');
    assertEquals(orders.length, 1, 'Scan returns 1 order key');
    
    // Empty prefix scan
    const empty = store.scan(tx2, 'nonexistent:');
    assertEquals(empty.length, 0, 'Empty scan for non-existent prefix');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Scan with Transaction Writes ==========
  console.log('\n--- Scan with Transaction Writes ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Setup
    const tx1 = store.begin();
    store.set(tx1, 'prefix:a', 'original-a');
    store.set(tx1, 'prefix:b', 'original-b');
    store.commit(tx1);
    
    // TX2 modifies and adds
    const tx2 = store.begin();
    store.set(tx2, 'prefix:a', 'modified-a');
    store.set(tx2, 'prefix:c', 'new-c');
    store.delete(tx2, 'prefix:b');
    
    const results = store.scan(tx2, 'prefix:');
    assertEquals(results.length, 2, 'Scan returns 2 keys (one deleted, one added)');
    
    const aResult = results.find(r => r.key === 'prefix:a');
    assertEquals(aResult.value, 'modified-a', 'Modified value seen in scan');
    
    const cResult = results.find(r => r.key === 'prefix:c');
    assertEquals(cResult.value, 'new-c', 'New key seen in scan');
    
    const bResult = results.find(r => r.key === 'prefix:b');
    assert(bResult === undefined, 'Deleted key not in scan');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Rollback ==========
  console.log('\n--- Rollback ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Setup
    const tx1 = store.begin();
    store.set(tx1, 'rollback-key', 'committed-value');
    store.commit(tx1);
    
    // TX2 makes changes but rolls back
    const tx2 = store.begin();
    store.set(tx2, 'rollback-key', 'uncommitted-value');
    store.set(tx2, 'new-key', 'should-not-exist');
    store.rollback(tx2);
    
    // Verify original value still there
    const tx3 = store.begin();
    const result1 = store.get(tx3, 'rollback-key');
    assertEquals(result1.value, 'committed-value', 'Rolled back change not visible');
    
    const result2 = store.get(tx3, 'new-key');
    assertEquals(result2.found, false, 'Rolled back new key not visible');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== WAL Recovery ==========
  console.log('\n--- WAL Recovery ---');
  
  {
    // Create store and perform operations
    let store = new MVCCStore(walPath);
    
    const tx1 = store.begin();
    store.set(tx1, 'persist-key', 'persist-value');
    store.commit(tx1);
    
    const tx2 = store.begin();
    store.set(tx2, 'another-key', 'another-value');
    store.set(tx2, 'delete-me', 'temp');
    store.commit(tx2);
    
    const tx3 = store.begin();
    store.delete(tx3, 'delete-me');
    store.commit(tx3);
    
    store.close();
    
    // Recover from WAL
    store = await MVCCStore.recover(walPath);
    
    // Verify recovered state
    const tx4 = store.begin();
    const result1 = store.get(tx4, 'persist-key');
    assertEquals(result1, { value: 'persist-value', found: true }, 'Recovered: persist-key exists');
    
    const result2 = store.get(tx4, 'another-key');
    assertEquals(result2, { value: 'another-value', found: true }, 'Recovered: another-key exists');
    
    const result3 = store.get(tx4, 'delete-me');
    assertEquals(result3, { value: null, found: false }, 'Recovered: delete-me is deleted');
    
    // Scan should work
    const all = store.scan(tx4, '');
    assert(all.length >= 2, 'Recovered: scan returns keys');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Recovery of Uncommitted Transactions ==========
  console.log('\n--- Recovery of Uncommitted Transactions ---');
  
  {
    // Create store with uncommitted transaction
    let store = new MVCCStore(walPath);
    
    const tx1 = store.begin();
    store.set(tx1, 'committed', 'yes');
    store.commit(tx1);
    
    const tx2 = store.begin();
    store.set(tx2, 'uncommitted', 'should-not-exist');
    // No commit for tx2
    
    store.close();
    
    // Recover
    store = await MVCCStore.recover(walPath);
    
    const tx3 = store.begin();
    const result1 = store.get(tx3, 'committed');
    assertEquals(result1, { value: 'yes', found: true }, 'Committed key survives recovery');
    
    const result2 = store.get(tx3, 'uncommitted');
    assertEquals(result2.found, false, 'Uncommitted key does not survive recovery');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Compaction ==========
  console.log('\n--- Compaction ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Create multiple versions
    for (let i = 1; i <= 5; i++) {
      const tx = store.begin();
      store.set(tx, 'versioned-key', `value-${i}`);
      store.commit(tx);
    }
    
    // Check version count before compaction
    const versionsBefore = store.data.get('versioned-key');
    assert(versionsBefore.length >= 5, 'Multiple versions exist before compaction');
    
    // Compact (no active transactions)
    store.compact();
    
    // Check version count after compaction
    const versionsAfter = store.data.get('versioned-key');
    assert(versionsAfter.length <= 2, 'Versions compacted to minimum');
    
    // Verify latest value still accessible
    const tx = store.begin();
    const result = store.get(tx, 'versioned-key');
    assertEquals(result.value, 'value-5', 'Latest value still accessible after compaction');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Compaction with Active Transactions ==========
  console.log('\n--- Compaction with Active Transactions ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Create initial version
    const tx1 = store.begin();
    store.set(tx1, 'protected-key', 'v1');
    store.commit(tx1);
    
    // Create second version
    const tx2 = store.begin();
    store.set(tx2, 'protected-key', 'v2');
    store.commit(tx2);
    
    // Start long-running transaction that needs v1
    const txLong = store.begin();
    const longStartValue = store.get(txLong, 'protected-key');
    assertEquals(longStartValue.value, 'v2', 'Long tx sees v2 at start');
    
    // Create more versions
    for (let i = 3; i <= 5; i++) {
      const tx = store.begin();
      store.set(tx, 'protected-key', `v${i}`);
      store.commit(tx);
    }
    
    // Compact while txLong is active
    store.compact();
    
    // Long transaction should still be able to read its snapshot
    // Note: Since txLong started after v2 was committed, it sees v2
    const valueAfterCompact = store.get(txLong, 'protected-key');
    assertEquals(valueAfterCompact.value, 'v2', 'Long tx still sees correct snapshot after compaction');
    
    // New transaction sees latest
    const txNew = store.begin();
    const newValue = store.get(txNew, 'protected-key');
    assertEquals(newValue.value, 'v5', 'New tx sees latest value');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Complex Scenario ==========
  console.log('\n--- Complex Scenario ---');
  
  {
    const store = new MVCCStore(walPath);
    
    // Multiple concurrent transactions
    const tx1 = store.begin();
    const tx2 = store.begin();
    
    store.set(tx1, 'shared1', 'tx1-value');
    store.set(tx2, 'shared2', 'tx2-value');
    
    // tx1 commits first
    assert(store.commit(tx1) === true, 'TX1 commits');
    
    // tx2 commits (no conflict, different keys)
    assert(store.commit(tx2) === true, 'TX2 commits without conflict');
    
    // Verify both values
    const tx3 = store.begin();
    assertEquals(store.get(tx3, 'shared1').value, 'tx1-value', 'TX1 value persisted');
    assertEquals(store.get(tx3, 'shared2').value, 'tx2-value', 'TX2 value persisted');
    
    store.close();
  }
  cleanupWal(walPath);

  // ========== Summary ==========
  console.log('\n=== Test Summary ===');
  console.log(`Total: ${testCount}, Passed: ${passCount}, Failed: ${failCount}`);
  
  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
