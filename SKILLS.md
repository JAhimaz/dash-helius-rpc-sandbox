# DASH Workflow Builder — LLM Skill Guide

You are generating workflow JSON for DASH, a visual Solana RPC workflow builder. Users will ask you to build workflows that chain RPC calls, transform data, filter results, and aggregate values. Your output must be a valid JSON object that can be imported directly into the app.

## Workflow JSON Schema

```json
{
  "version": 1,
  "order": ["node-1", "node-2", "node-3"],
  "nodes": [
    {
      "id": "node-1",
      "name": "Human-readable name",
      "method": "getBalance",
      "schemaMode": "known",
      "params": [
        { "name": "address", "value": { "type": "literal", "value": "So11111111111111111111111111111111111111112" } }
      ],
      "rawParamsJson": "",
      "position": { "x": 0, "y": 0 }
    }
  ]
}
```

### Required Top-Level Fields

| Field | Type | Description |
|---|---|---|
| `version` | `1` | Always `1` |
| `order` | `string[]` | Node IDs in execution order (first node runs first) |
| `nodes` | `array` | Array of node objects |

### Node Object Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique identifier (e.g., `"node-1"`, `"get-balance"`, any unique string) |
| `name` | `string` | Yes | Display name shown on the canvas |
| `method` | `string` | Yes | Must match an available method exactly (see Methods section) |
| `schemaMode` | `"known"` or `"unknown"` | Yes | Use `"known"` for all listed methods. Use `"unknown"` only for unlisted methods |
| `params` | `ParamBinding[]` | Yes | Array of named parameter bindings |
| `rawParamsJson` | `string` | Yes | Raw JSON string for unknown schema nodes. Use `""` for known schema nodes |
| `position` | `{ x, y }` | No | Canvas position. Space nodes ~400px apart horizontally |
| `repeat` | `object` | No | Repeat configuration (see Repeat section) |
| `resetOnNewRun` | `boolean` | No | For Value Aggregator: reset accumulator on each run |

## Parameter Values

Every parameter is a `ParamBinding`: `{ "name": "paramName", "value": ParamValue }`.

There are two types of `ParamValue`:

### Literal Value
Direct value. Use for constants, addresses, configuration.
```json
{ "type": "literal", "value": "So11111111111111111111111111111111111111112" }
```

### Reference Value
Reads from another node's output. This is how you chain nodes together.
```json
{ "type": "ref", "nodeId": "node-1", "path": "result.value" }
```

### Reference Path Syntax
- Dot notation: `result.value`, `transaction.message.accountKeys`
- Array index: `result[0]`, `accounts[2].pubkey`
- Array spread: `result[].value` — maps over each array element (used with List nodes)
- Empty path `""` — references the entire output

## Available Methods

### Custom Utility Nodes

These are the most important for building complex workflows.

#### Script
Runs custom JavaScript. The most flexible node — use for any transformation, filtering, or computation that other nodes can't handle.
- `input` (any) — data to process, usually a reference to another node
- `code` (string, required) — JavaScript function body. Access data via `input`. Use `return` to set output. Return `null` to skip downstream nodes in List iterations.

```json
{
  "name": "code",
  "value": {
    "type": "literal",
    "value": "const keys = input.accountKeys;\nconst idx = keys.indexOf('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');\nif (idx < 0) return null;\nreturn { tokenIndex: idx, keys };"
  }
}
```

**Script code runs sandboxed** — no access to DOM, cookies, localStorage, or parent page. 10-second timeout.

#### List
Iterates over an array. Downstream nodes run once per item. Essential for processing multiple transactions, accounts, etc.
- `value` (any, required) — an array to iterate over

When a node references a List node's output, the execution engine automatically iterates: for each item in the array, downstream nodes execute with that single item as the List's output.

#### Filter
Filters an array by a condition on each element.
- `input` (any, required) — reference to an array
- `path` (string, required) — dot-path to test on each element (e.g., `meta.err`)
- `operator` (string, required) — one of: `>`, `<`, `>=`, `<=`, `!=`, `==`, `contains`, `not contains`, `is null`, `is not null`
- `compareTo` (any) — value to compare against (not needed for `is null` / `is not null`)

#### Value Aggregator
Accumulates a value across iterations. Use after a List to sum, count, etc.
- `value` (number, required) — incoming value each iteration
- `operation` (string, required) — `add`, `subtract`, `multiply`, `divide`
- `initialValue` (number) — starting value, defaults to 0

#### Arithmetic
Single math operation on one value.
- `input` (number, required) — the input value
- `operation` (string, required) — `add`, `subtract`, `multiply`, `divide`
- `operand` (number, required) — value to operate with

#### Log Output
Outputs a value to the console for debugging.
- `value` (any, required) — any value to log

### Solana RPC Methods (56 methods)

All standard Solana and Helius RPC methods. Key ones:

| Method | Required Params | Description |
|---|---|---|
| `getAccountInfo` | `pubkey`*, `encoding` | Get account data |
| `getBalance` | `address`* | Get SOL balance in lamports |
| `getBlock` | `slot`* | Get block data |
| `getBlockCommitment` | `slot`* | Get block commitment |
| `getBlockHeight` | — | Get current block height |
| `getBlockProduction` | — | Get block production info |
| `getBlocks` | `slot`* | Get confirmed blocks in a range |
| `getBlocksWithLimit` | `start_slot`*, `limit`* | Get blocks with limit |
| `getBlockTime` | `slot`* | Get estimated block time |
| `getClusterNodes` | — | Get all cluster node info |
| `getEpochInfo` | — | Get current epoch info (slot, height, epoch) |
| `getEpochSchedule` | — | Get epoch schedule config |
| `getFeeForMessage` | `transaction`* | Get fee for a serialized message |
| `getFirstAvailableBlock` | — | Get oldest available block slot |
| `getGenesisHash` | — | Get network genesis hash |
| `getHealth` | — | Check node health status |
| `getHighestSnapshotSlot` | — | Get highest snapshot slot |
| `getIdentity` | — | Get node identity pubkey |
| `getInflationGovernor` | — | Get inflation model params |
| `getInflationRate` | — | Get current inflation rate |
| `getInflationReward` | `address`* (array) | Get staking rewards for addresses |
| `getLargestAccounts` | — | Get top 20 SOL holders |
| `getLatestBlockhash` | — | Get latest blockhash for transactions |
| `getLeaderSchedule` | — | Get validator leader schedule |
| `getMaxRetransmitSlot` | — | Get max retransmit slot |
| `getMaxShredInsertSlot` | — | Get max shred insert slot |
| `getMinimumBalanceForRentExemption` | `address`* (data size in bytes) | Get rent-exempt minimum |
| `getMultipleAccounts` | `address`* (array) | Batch fetch accounts |
| `getProgramAccounts` | `address`* (program ID) | Get all accounts owned by a program |
| `getProgramAccountsV2` | `address`* | Paginated program accounts |
| `getRecentPerformanceSamples` | — | Get network performance metrics |
| `getRecentPrioritizationFees` | — | Get recent priority fee levels |
| `getSignatureStatuses` | `transaction`* (array) | Get tx confirmation statuses |
| `getSignaturesForAddress` | `address`* | Get transaction signatures |
| `getSlot` | — | Get current slot |
| `getSlotLeader` | — | Get current slot leader |
| `getSlotLeaders` | `slot`*, `limit`* | Get slot leaders for a range |
| `getStakeMinimumDelegation` | — | Get min stake delegation amount |
| `getSupply` | — | Get SOL supply breakdown |
| `getTokenAccountBalance` | `address`* | Get SPL token balance |
| `getTokenAccountsByDelegate` | `address`* | Get token accounts by delegate |
| `getTokenAccountsByOwner` | `address`*, `programId` or `mint` | Get token accounts |
| `getTokenAccountsByOwnerV2` | `address`* | Paginated token accounts |
| `getTokenLargestAccounts` | `address`* (mint) | Get top 20 token holders |
| `getTokenSupply` | `address`* (mint) | Get token total supply |
| `getTransaction` | `transaction`* (signature), `encoding`* | Get a single transaction |
| `getTransactionCount` | — | Get total transaction count |
| `getTransactionsForAddress` | `address`* | Get transaction history with filters |
| `getVersion` | — | Get Solana node version |
| `getVoteAccounts` | — | Get validator vote accounts |
| `isBlockhashValid` | `blockhash`* | Check if blockhash is still valid |
| `minimumLedgerSlot` | — | Get lowest ledger slot |
| `requestAirdrop` | `address`*, `value`* | Devnet/testnet airdrop |
| `sendTransaction` | `transaction`* | Submit a signed transaction |
| `simulateBundle` | (unknown schema, use raw JSON) | Simulate a JITO bundle |
| `simulateTransaction` | `transaction`* | Simulate a transaction |

### DAS (Digital Asset Standard) Methods

| Method | Required Params | Description |
|---|---|---|
| `getAsset` | `id`* | Get a single digital asset by mint |
| `getAssetBatch` | `ids`* (array) | Get multiple assets |
| `getAssetsByOwner` | `ownerAddress`* | Get all assets owned by a wallet |
| `getAssetsByCreator` | `creatorAddress`* | Get assets by creator |
| `searchAssets` | `tokenType`* | Search assets with filters |

### Wallet API Methods

| Method | Required Params | Description |
|---|---|---|
| `getWalletBalances` | `wallet`* | Get all token balances for a wallet |
| `getWalletFundingSource` | `wallet`* | Get wallet funding source |
| `getWalletHistory` | `wallet`* | Get parsed transaction history |
| `getWalletIdentity` | `wallet`* | Get wallet identity info |
| `getWalletTransfers` | `wallet`* | Get token transfers |

### Priority Fee Methods

| Method | Required Params | Description |
|---|---|---|
| `getPriorityFeeEstimate` | `transaction` or `accountKeys` | Get recommended priority fees for optimal tx inclusion |

## Repeat Configuration

Optional. Runs a node multiple times on an interval.

```json
{
  "repeat": {
    "enabled": true,
    "count": 5,
    "interval": 2,
    "unit": "seconds",
    "loopCount": 1
  }
}
```

- `count` — times to repeat (1-1000)
- `interval` — delay between repeats
- `unit` — `"milliseconds"`, `"seconds"`, or `"minutes"`
- `loopCount` — how many full loops (0 = infinite)

## Node Positioning

Space nodes logically on the canvas:
- Horizontal flow: increment `x` by ~400 for each step
- Parallel nodes: same `x`, different `y` (offset by ~220)
- Start at `{ "x": 0, "y": 0 }`

## Connection Model

Nodes are **not** connected by explicit edges. Connections are implicit through **reference params**. When node B has a param with `{ "type": "ref", "nodeId": "node-a", "path": "..." }`, it reads from node A's output. The app draws edges automatically from these references.

## Execution Model

1. Nodes execute in `order` array sequence
2. Each node's output is stored and available to later nodes via references
3. List nodes trigger iteration — downstream nodes run once per array item
4. Script nodes returning `null` skip all downstream nodes for that iteration
5. Value Aggregator accumulates across iterations, outputs final result after the loop

## Examples

### Example 1: Get SOL Balance

```json
{
  "version": 1,
  "order": ["get-balance"],
  "nodes": [
    {
      "id": "get-balance",
      "name": "Get SOL Balance",
      "method": "getBalance",
      "schemaMode": "known",
      "params": [
        { "name": "address", "value": { "type": "literal", "value": "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg" } },
        { "name": "commitment", "value": { "type": "literal", "value": "confirmed" } }
      ],
      "rawParamsJson": "",
      "position": { "x": 0, "y": 0 }
    }
  ]
}
```

### Example 2: Get All NFTs for a Wallet

```json
{
  "version": 1,
  "order": ["get-assets"],
  "nodes": [
    {
      "id": "get-assets",
      "name": "Wallet NFTs",
      "method": "getAssetsByOwner",
      "schemaMode": "known",
      "params": [
        { "name": "ownerAddress", "value": { "type": "literal", "value": "YOUR_WALLET_ADDRESS" } },
        { "name": "page", "value": { "type": "literal", "value": 1 } },
        { "name": "limit", "value": { "type": "literal", "value": 100 } }
      ],
      "rawParamsJson": "",
      "position": { "x": 0, "y": 0 }
    }
  ]
}
```

### Example 3: Multi-step — Get Transactions, Filter Errors, Count Successful

```json
{
  "version": 1,
  "order": ["fetch-txs", "filter-success", "list-txs", "count"],
  "nodes": [
    {
      "id": "fetch-txs",
      "name": "Fetch Transactions",
      "method": "getTransactionsForAddress",
      "schemaMode": "known",
      "params": [
        { "name": "address", "value": { "type": "literal", "value": "YOUR_ADDRESS" } },
        { "name": "limit", "value": { "type": "literal", "value": 20 } }
      ],
      "rawParamsJson": "",
      "position": { "x": 0, "y": 0 }
    },
    {
      "id": "filter-success",
      "name": "Only Successful TXs",
      "method": "Filter",
      "schemaMode": "known",
      "params": [
        { "name": "input", "value": { "type": "ref", "nodeId": "fetch-txs", "path": "" } },
        { "name": "path", "value": { "type": "literal", "value": "meta.err" } },
        { "name": "operator", "value": { "type": "literal", "value": "is null" } }
      ],
      "rawParamsJson": "",
      "position": { "x": 400, "y": 0 }
    },
    {
      "id": "list-txs",
      "name": "Iterate Transactions",
      "method": "List",
      "schemaMode": "known",
      "params": [
        { "name": "value", "value": { "type": "ref", "nodeId": "filter-success", "path": "" } }
      ],
      "rawParamsJson": "",
      "position": { "x": 800, "y": 0 }
    },
    {
      "id": "count",
      "name": "Count Transactions",
      "method": "Value Aggregator",
      "schemaMode": "known",
      "params": [
        { "name": "value", "value": { "type": "literal", "value": 1 } },
        { "name": "operation", "value": { "type": "literal", "value": "add" } },
        { "name": "initialValue", "value": { "type": "literal", "value": 0 } }
      ],
      "rawParamsJson": "",
      "resetOnNewRun": true,
      "position": { "x": 1200, "y": 0 }
    }
  ]
}
```

### Example 4: Script Node — Parse Token Transfer Amounts

```json
{
  "version": 1,
  "order": ["fetch-txs", "list-txs", "parse-transfer", "sum-amounts"],
  "nodes": [
    {
      "id": "fetch-txs",
      "name": "Fetch TXs",
      "method": "getTransactionsForAddress",
      "schemaMode": "known",
      "params": [
        { "name": "address", "value": { "type": "literal", "value": "YOUR_ADDRESS" } },
        { "name": "limit", "value": { "type": "literal", "value": 50 } }
      ],
      "rawParamsJson": "",
      "position": { "x": 0, "y": 0 }
    },
    {
      "id": "list-txs",
      "name": "Each Transaction",
      "method": "List",
      "schemaMode": "known",
      "params": [
        { "name": "value", "value": { "type": "ref", "nodeId": "fetch-txs", "path": "" } }
      ],
      "rawParamsJson": "",
      "position": { "x": 400, "y": 0 }
    },
    {
      "id": "parse-transfer",
      "name": "Parse SOL Transfer",
      "method": "Script",
      "schemaMode": "known",
      "params": [
        { "name": "input", "value": { "type": "ref", "nodeId": "list-txs", "path": "" } },
        {
          "name": "code",
          "value": {
            "type": "literal",
            "value": "const pre = input.meta.preBalances[0];\nconst post = input.meta.postBalances[0];\nconst diff = (pre - post) / 1e9;\nif (diff <= 0) return null;\nreturn { solSpent: diff };"
          }
        }
      ],
      "rawParamsJson": "",
      "position": { "x": 800, "y": 0 }
    },
    {
      "id": "sum-amounts",
      "name": "Total SOL Spent",
      "method": "Value Aggregator",
      "schemaMode": "known",
      "params": [
        { "name": "value", "value": { "type": "ref", "nodeId": "parse-transfer", "path": "solSpent" } },
        { "name": "operation", "value": { "type": "literal", "value": "add" } },
        { "name": "initialValue", "value": { "type": "literal", "value": 0 } }
      ],
      "rawParamsJson": "",
      "resetOnNewRun": true,
      "position": { "x": 1200, "y": 0 }
    }
  ]
}
```

## Rules

1. **Every node must be in the `order` array.** The `order` determines execution sequence.
2. **A node can only reference nodes that appear earlier in `order`.** Forward references will fail.
3. **Reference paths must match the source node's actual output structure.** If unsure, use `""` for the entire output.
4. **Use `schemaMode: "known"` for all methods listed above.** Use `"unknown"` only for methods not in the registry (rare).
5. **`rawParamsJson` must be `""` for known schema nodes.** Only populate it for unknown schema nodes.
6. **List nodes must reference an array.** The downstream nodes execute once per element.
7. **Value Aggregator should have `resetOnNewRun: true`** so it resets between workflow runs.
8. **Script code must be a string with `\n` for newlines** — not actual newlines in the JSON value.
9. **Script nodes return `null` to skip** — use this for conditional logic within List iterations.
10. **Node IDs must be unique.** Use descriptive kebab-case IDs.
11. **Always set `"version": 1`** at the top level.
12. **Do not include `output` fields** — those are runtime-only.
