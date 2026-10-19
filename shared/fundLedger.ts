export const FUND_KINDS: Record<string,string> = {opening:'启用时余额',initial:'账户初始余额',recharge:'充值',adjustment:'管理员调账',charge:'扣费 / 预扣',refund:'退款',credit:'其他增加',debit:'其他扣减',quota_mode:'额度模式变更'};
export const FUND_ACCOUNTS: Record<string,string> = {user:'个人余额',org:'组织余额',token:'Token 额度'};
export type FundEntry = {id:number;account_type:string;account_id:number;account_name:string;user_id:number|null;kind:string;delta:number|null;balance_before:number;balance_after:number;actor_id:number|null;actor_name:string|null;content_id:number|null;operation:string|null;created_at:string};
export type FundLedgerResult = {items:FundEntry[];total:number;page:number;pageSize:number;startedAt:string|null};
