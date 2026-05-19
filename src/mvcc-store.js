/**
 * MVCC KV Store Implementation
 * 
 * Features:
 * - Transaction snapshots at begin time
 * - Read-your-own-writes
 * - Conflict detection on commit
 * - Tombstone-based deletes
 * - Prefix scan with snapshot isolation
 * - WAL for durability
 * - Recovery from WAL
 * - Safe compaction
 */

const fs = require('fs');
const path = require('path');

// Version entry structure
class VersionEntry {
  constructor(value, txId, timestamp, isTombstone = false) {
    this.value = value;
    this.txId = txId;
    this.timestamp = timestamp;
    this.isTombstone = isTombstone;
  }
}

// WAL Entry types
const WALEntryType = {
  BEGIN: 'BEGIN',
  SET: 'SET',
  DELETE: 'DELETE',
  COMMIT: 'COMMIT',
  ROLLBACK: 'ROLLBACK'
};

class WALEntry {
  constructor(type, txId, key, value, timestamp) {
    this.type = type;
    this.txId = txId;
    this.key = key;
    this.value = value;
    this.timestamp = timestamp;
  }

  serialize() {
    return JSON.stringify(this);
  }

  static deserialize(str) {
    const obj = JSON.parse(str);
    return new WALEntry(obj.type, obj.txId, obj.key, obj.value, obj.timestamp);
  }
}

// Transaction states
const TxState = {
  ACTIVE: 'ACTIVE',
  COMMITTED: 'COMMITTED',
  ABORTED: 'ABORTED'
};

class Transaction {
  constructor(txId, startTime) {
    this.txId = txId;
    this.startTime = startTime;
    this.state = TxState.ACTIVE;
    this.writeSet = new Map(); // key -> {value, isTombstone}
    this.readSet = new Set();
  }
}

class MVCCStore {
  constructor(walPath = './wal.log') {
    this.walPath = walPath;
    
    // Main data store: key -> [VersionEntry...] (sorted by timestamp desc)
    this.data = new Map();
    
    // Active transactions: txId -> Transaction
    this.transactions = new Map();
    
    // Committed transactions: txId -> {commitTime, writeKeys}
    this.committedTxns = new Map();
    
    // Global timestamp counter
    this.timestampCounter = 0;
    
    // Next transaction ID
    this.nextTxId = 1;
    
    // WAL file handle
    this.walStream = null;
    
    // Initialize WAL
    this._initWAL();
  }

  _initWAL() {
    // Ensure directory exists
    const dir = path.dirname(this.walPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Append mode
    this.walStream = fs.openSync(this.walPath, 'a');
  }

  _writeWAL(entry) {
    const line = entry.serialize() + '\n';
    fs.writeSync(this.walStream, line);
    fs.fsyncSync(this.walStream);
  }

  _getNextTimestamp() {
    return ++this.timestampCounter;
  }

  _getNextTxId() {
    return this.nextTxId++;
  }

  /**
   * Begin a new transaction
   * Returns transaction ID
   */
  begin() {
    const txId = this._getNextTxId();
    const startTime = this._getNextTimestamp();
    
    const tx = new Transaction(txId, startTime);
    this.transactions.set(txId, tx);
    
    // Log BEGIN to WAL
    this._writeWAL(new WALEntry(WALEntryType.BEGIN, txId, null, null, startTime));
    
    return txId;
  }

  /**
   * Get value for a key in the context of a transaction
   * Returns {value, found} or null if not found
   */
  get(txId, key) {
    const tx = this.transactions.get(txId);
    if (!tx || tx.state !== TxState.ACTIVE) {
      throw new Error(`Invalid transaction ${txId}`);
    }

    // First check transaction's own write set (read-your-own-writes)
    if (tx.writeSet.has(key)) {
      const writeEntry = tx.writeSet.get(key);
      if (writeEntry.isTombstone) {
        return { value: null, found: false };
      }
      return { value: writeEntry.value, found: true };
    }

    // Find visible version from committed transactions
    const versions = this.data.get(key);
    if (!versions || versions.length === 0) {
      return { value: null, found: false };
    }

    // Find the latest version that is visible to this transaction
    // Visible if: committed before tx started AND committed tx is in committedTxns
    for (const version of versions) {
      if (version.txId === null) {
        // Initial data (before any transaction)
        if (!version.isTombstone) {
          return { value: version.value, found: true };
        }
        return { value: null, found: false };
      }

      const committingTx = this.committedTxns.get(version.txId);
      if (committingTx && committingTx.commitTime < tx.startTime) {
        // This version was committed before our transaction started
        if (version.isTombstone) {
          return { value: null, found: false };
        }
        return { value: version.value, found: true };
      }
    }

    return { value: null, found: false };
  }

  /**
   * Set a key-value pair in the context of a transaction
   */
  set(txId, key, value) {
    const tx = this.transactions.get(txId);
    if (!tx || tx.state !== TxState.ACTIVE) {
      throw new Error(`Invalid transaction ${txId}`);
    }

    tx.writeSet.set(key, { value, isTombstone: false });
    tx.readSet.add(key);

    // Log SET to WAL
    this._writeWAL(new WALEntry(WALEntryType.SET, txId, key, value, this._getNextTimestamp()));
  }

  /**
   * Delete a key in the context of a transaction (tombstone)
   */
  delete(txId, key) {
    const tx = this.transactions.get(txId);
    if (!tx || tx.state !== TxState.ACTIVE) {
      throw new Error(`Invalid transaction ${txId}`);
    }

    tx.writeSet.set(key, { value: null, isTombstone: true });
    tx.readSet.add(key);

    // Log DELETE to WAL
    this._writeWAL(new WALEntry(WALEntryType.DELETE, txId, key, null, this._getNextTimestamp()));
  }

  /**
   * Scan keys with given prefix in the context of a transaction
   * Returns sorted array of {key, value}
   */
  scan(txId, prefix) {
    const tx = this.transactions.get(txId);
    if (!tx || tx.state !== TxState.ACTIVE) {
      throw new Error(`Invalid transaction ${txId}`);
    }

    const results = [];
    const seenKeys = new Set();

    // First, process keys in transaction's write set
    for (const [key, writeEntry] of tx.writeSet.entries()) {
      if (key.startsWith(prefix)) {
        seenKeys.add(key);
        if (!writeEntry.isTombstone) {
          results.push({ key, value: writeEntry.value });
        }
      }
    }

    // Then, scan committed data
    for (const [key, versions] of this.data.entries()) {
      if (key.startsWith(prefix) && !seenKeys.has(key)) {
        // Find visible version
        for (const version of versions) {
          if (version.txId === null) {
            // Initial data
            if (!version.isTombstone) {
              results.push({ key, value: version.value });
            }
            break;
          }

          const committingTx = this.committedTxns.get(version.txId);
          if (committingTx && committingTx.commitTime < tx.startTime) {
            if (!version.isTombstone) {
              results.push({ key, value: version.value });
            }
            break;
          }
        }
      }
    }

    // Sort by key
    results.sort((a, b) => a.key.localeCompare(b.key));
    return results;
  }

  /**
   * Commit a transaction
   * Returns true on success, false on conflict
   */
  commit(txId) {
    const tx = this.transactions.get(txId);
    if (!tx || tx.state !== TxState.ACTIVE) {
      throw new Error(`Invalid transaction ${txId}`);
    }

    // Conflict detection: check if any key in writeSet was modified after tx started
    for (const key of tx.writeSet.keys()) {
      const versions = this.data.get(key);
      if (versions && versions.length > 0) {
        const latestVersion = versions[0]; // Most recent version
        if (latestVersion.txId !== null) {
          const committingTx = this.committedTxns.get(latestVersion.txId);
          if (committingTx && committingTx.commitTime >= tx.startTime) {
            // Conflict: another transaction committed after we started
            tx.state = TxState.ABORTED;
            this._writeWAL(new WALEntry(WALEntryType.ROLLBACK, txId, null, null, this._getNextTimestamp()));
            return false;
          }
        }
      }
    }

    // No conflicts, proceed with commit
    const commitTime = this._getNextTimestamp();
    const writeTimestamp = commitTime;

    // Apply writes to data store
    for (const [key, writeEntry] of tx.writeSet.entries()) {
      let versions = this.data.get(key);
      if (!versions) {
        versions = [];
        this.data.set(key, versions);
      }

      const newVersion = new VersionEntry(
        writeEntry.value,
        txId,
        writeTimestamp,
        writeEntry.isTombstone
      );
      
      // Insert at beginning (newest first)
      versions.unshift(newVersion);
    }

    // Record committed transaction
    this.committedTxns.set(txId, {
      commitTime,
      writeKeys: new Set(tx.writeSet.keys())
    });

    tx.state = TxState.COMMITTED;

    // Log COMMIT to WAL
    this._writeWAL(new WALEntry(WALEntryType.COMMIT, txId, null, null, commitTime));

    return true;
  }

  /**
   * Rollback a transaction
   */
  rollback(txId) {
    const tx = this.transactions.get(txId);
    if (!tx || tx.state !== TxState.ACTIVE) {
      throw new Error(`Invalid transaction ${txId}`);
    }

    tx.state = TxState.ABORTED;

    // Log ROLLBACK to WAL
    this._writeWAL(new WALEntry(WALEntryType.ROLLBACK, txId, null, null, this._getNextTimestamp()));
  }

  /**
   * Compact old versions that are no longer needed
   * Only keeps versions needed by active transactions
   */
  compact() {
    // Find the earliest start time among active transactions
    let minActiveStartTime = Infinity;
    for (const tx of this.transactions.values()) {
      if (tx.state === TxState.ACTIVE) {
        minActiveStartTime = Math.min(minActiveStartTime, tx.startTime);
      }
    }

    // For each key, keep only necessary versions
    for (const [key, versions] of this.data.entries()) {
      if (versions.length <= 1) {
        continue; // Nothing to compact
      }

      const newVersions = [];
      let keptNewest = false;
      let newestVisibleToMinTx = null;

      // First pass: find the newest version visible to the earliest active transaction
      // This version must be preserved as it's what that transaction would see
      if (minActiveStartTime !== Infinity) {
        for (const version of versions) {
          if (version.txId === null) {
            // Initial version - always visible if nothing else is
            if (newestVisibleToMinTx === null) {
              newestVisibleToMinTx = version;
            }
            continue;
          }

          const committingTx = this.committedTxns.get(version.txId);
          if (committingTx && committingTx.commitTime < minActiveStartTime) {
            // This version was committed before the earliest active tx started
            // It's visible to that transaction
            newestVisibleToMinTx = version;
            break; // First one we find is the newest visible
          }
        }
      }

      for (let i = 0; i < versions.length; i++) {
        const version = versions[i];
        
        // Always keep the newest version (for new transactions)
        if (!keptNewest) {
          newVersions.push(version);
          keptNewest = true;
          continue;
        }

        if (version.txId === null) {
          // Keep initial version as fallback
          newVersions.push(version);
          continue;
        }

        const committingTx = this.committedTxns.get(version.txId);
        if (!committingTx) {
          // Transaction info lost, keep it to be safe
          newVersions.push(version);
          continue;
        }

        // Keep if this is the version visible to the earliest active transaction
        if (minActiveStartTime !== Infinity && version === newestVisibleToMinTx) {
          newVersions.push(version);
          continue;
        }

        // Keep if this version might be visible to some active transaction
        // (committed after the earliest active tx started but before some later ones)
        if (minActiveStartTime !== Infinity && committingTx.commitTime >= minActiveStartTime) {
          newVersions.push(version);
          continue;
        }

        // Otherwise, skip (compact away)
      }

      this.data.set(key, newVersions);
    }
  }

  /**
   * Close the store (flush WAL)
   */
  close() {
    if (this.walStream !== null) {
      fs.closeSync(this.walStream);
      this.walStream = null;
    }
  }

  /**
   * Static method to recover store from WAL
   * Returns a new MVCCStore instance with recovered state
   */
  static async recover(walPath) {
    const store = new MVCCStore(walPath);
    
    // Clear existing data (we'll replay from WAL)
    store.data.clear();
    store.transactions.clear();
    store.committedTxns.clear();
    store.timestampCounter = 0;
    store.nextTxId = 1;

    if (!fs.existsSync(walPath)) {
      return store;
    }

    const content = fs.readFileSync(walPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);

    // Track transaction states during recovery
    const pendingTxns = new Map(); // txId -> {startTime, writeSet}

    for (const line of lines) {
      const entry = WALEntry.deserialize(line);
      
      // Update max timestamp and txId
      store.timestampCounter = Math.max(store.timestampCounter, entry.timestamp);
      store.nextTxId = Math.max(store.nextTxId, entry.txId + 1);

      switch (entry.type) {
        case WALEntryType.BEGIN:
          pendingTxns.set(entry.txId, {
            startTime: entry.timestamp,
            writeSet: new Map()
          });
          break;

        case WALEntryType.SET:
          const setData = pendingTxns.get(entry.txId);
          if (setData) {
            setData.writeSet.set(entry.key, { value: entry.value, isTombstone: false });
          }
          break;

        case WALEntryType.DELETE:
          const delData = pendingTxns.get(entry.txId);
          if (delData) {
            delData.writeSet.set(entry.key, { value: null, isTombstone: true });
          }
          break;

        case WALEntryType.COMMIT:
          const commitData = pendingTxns.get(entry.txId);
          if (commitData) {
            // Apply writes
            for (const [key, writeEntry] of commitData.writeSet.entries()) {
              let versions = store.data.get(key);
              if (!versions) {
                versions = [];
                store.data.set(key, versions);
              }

              const newVersion = new VersionEntry(
                writeEntry.value,
                entry.txId,
                entry.timestamp,
                writeEntry.isTombstone
              );
              versions.unshift(newVersion);
            }

            store.committedTxns.set(entry.txId, {
              commitTime: entry.timestamp,
              writeKeys: new Set(commitData.writeSet.keys())
            });

            pendingTxns.delete(entry.txId);
          }
          break;

        case WALEntryType.ROLLBACK:
          pendingTxns.delete(entry.txId);
          break;
      }
    }

    // Re-open WAL in append mode
    store.close();
    store._initWAL();

    return store;
  }
}

module.exports = { MVCCStore, VersionEntry, WALEntry, WALEntryType, TxState };
