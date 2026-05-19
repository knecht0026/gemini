# MVCC KV Store Implementation

A memory-based Multi-Version Concurrency Control (MVCC) Key-Value Store with full transaction support, WAL persistence, and safe compaction.

## Features

- **Transaction Snapshot Isolation**: Each transaction reads a consistent snapshot from its `begin()` time
- **Read-Your-Own-Writes**: Transactions can see their own uncommitted writes
- **Conflict Detection**: Commit fails if any key in the write set was modified by another transaction after this transaction started
- **Tombstone Deletes**: Deleted keys are marked with tombstones instead of being removed immediately
- **Prefix Scan**: Returns sorted key-value pairs matching a prefix in the current transaction's snapshot
- **WAL Persistence**: All committed transactions are logged to Write-Ahead Log
- **Recovery**: `recover(wal)` restores state to match pre-crash state exactly
- **Safe Compaction**: `compact()` removes old versions without breaking active transaction snapshots

## API

```javascript
const { MVCCStore } = require('./mvcc-store');

// Create new store
const store = new MVCCStore('./wal.log');

// Begin transaction
const txId = store.begin();

// Read/Write operations
store.set(txId, 'key', 'value');
const result = store.get(txId, 'key'); // { value, found }
store.delete(txId, 'key');
const results = store.scan(txId, 'prefix:'); // [{ key, value }, ...]

// Commit or rollback
const success = store.commit(txId); // true/false
store.rollback(txId);

// Recovery
const recoveredStore = await MVCCStore.recover('./wal.log');

// Compaction
store.compact();

// Close
store.close();
```

## Complexity Analysis

### Time Complexity

| Operation | Complexity | Notes |
|-----------|------------|-------|
| `begin()` | O(1) | Creates transaction record, writes WAL |
| `get(tx, key)` | O(V) | V = number of versions for the key (typically small) |
| `set(tx, key, value)` | O(1) | Adds to write set, writes WAL |
| `delete(tx, key)` | O(1) | Adds tombstone to write set, writes WAL |
| `scan(tx, prefix)` | O(N × V + K log K) | N = keys matching prefix, V = versions per key, K = result size |
| `commit(tx)` | O(W × V) | W = write set size, checks conflicts for each key |
| `rollback(tx)` | O(1) | Marks transaction aborted, writes WAL |
| `compact()` | O(K × V) | K = total keys, V = versions per key |
| `recover(wal)` | O(L) | L = number of WAL entries |

### Space Complexity

- **Data Store**: O(K × V) where K = unique keys, V = average versions per key
- **Active Transactions**: O(T × W) where T = active transactions, W = average write set size
- **Committed Txns Metadata**: O(C) where C = committed transactions (for conflict detection)
- **WAL**: O(O) where O = total operations performed

## Design Details

### Version Chain
Each key maps to a list of `VersionEntry` objects sorted by timestamp (newest first):
```
key -> [VersionEntry(ts=5, tx=3), VersionEntry(ts=3, tx=2), VersionEntry(ts=1, tx=null)]
```

### Snapshot Visibility
A version is visible to transaction T if:
1. The version's committing transaction committed before T started (`commitTime < T.startTime`), OR
2. The version has no transaction (initial data)

### Conflict Detection
On commit, for each key in the write set:
- Check if the latest version was committed after this transaction started
- If yes → conflict → abort
- If no → proceed with commit

### Tombstone Handling
Deleted keys store a `VersionEntry` with `isTombstone = true`. During reads:
- Tombstone returns `{ value: null, found: false }`
- Tombstones are preserved through compaction if needed by active transactions

### WAL Format
Each operation is logged as a JSON line:
```json
{"type":"BEGIN","txId":1,"key":null,"value":null,"timestamp":1}
{"type":"SET","txId":1,"key":"user:1","value":"alice","timestamp":2}
{"type":"COMMIT","txId":1,"key":null,"value":null,"timestamp":3}
```

### Compaction Safety
Compaction preserves:
1. The newest version (for new transactions)
2. The version visible to the earliest active transaction
3. Any version that might be visible to some active transaction
4. Initial versions as fallback

This ensures no active transaction loses its snapshot view.

## Running Tests

```bash
node src/mvcc-store.test.js
```

## Test Coverage

- Basic CRUD operations
- Snapshot isolation between concurrent transactions
- Read-your-own-writes semantics
- Write-write conflict detection
- Tombstone delete behavior
- Prefix scan with transaction writes
- Rollback correctness
- WAL recovery (committed and uncommitted transactions)
- Compaction with and without active transactions
- Complex concurrent scenarios
