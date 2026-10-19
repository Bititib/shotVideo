# Administrator fund ledger

The admin menu exposes /admin/fund-ledger. The API /api/admin/fund-ledger requires a signed-in platform administrator; organization administrators and ordinary users cannot read it. No new balance-edit endpoint is introduced.

SQLite triggers record actual balance changes to users, organizations and api_tokens in the same transaction as the mutation, including legacy direct SQL. The common balance/token services provide charge/refund/recharge context; admin balance edits and billing reconciliation provide administrator IDs. Older call sites without operation context are labelled as other increases/decreases. Task IDs are recorded only when the existing caller supplies them; missing IDs are not inferred from time or amount.

Existing balances are recorded once as opening snapshots without changing money or inventing historical transactions. New accounts receive an initial-balance entry. Repeated startup does not duplicate opening entries. Account deletion does not delete ledger history. Failed/rolled-back mutations do not produce committed movement entries. This is an audit layer; existing charge/refund idempotency rules remain responsible for preventing duplicate business operations.

Token quota is distinct from user/organization money. Switching to or from unlimited quota is a mode event with no cash delta. Unlimited-token usage counters do not represent balance movements and are excluded. Do not total token quota together with wallet balances.

Filters support account type/ID/name, movement type and inclusive Beijing calendar dates, with server-side pagination. Only safe ledger columns are returned; API keys, prompts and raw request metadata are never stored here. System/operator-unknown events are labelled honestly. There is no historical backfill, payment-provider receipt matching, CSV export or ordinary-user ledger in this first version.
