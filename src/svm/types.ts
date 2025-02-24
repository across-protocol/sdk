export type BridgedToHubPoolEvent = {
    amount: string;
    mint: string;
};

export type TokensBridgedEvent = {
    amount_to_return: string;
    chain_id: string;
    leaf_id: number;
    l2_token_address: string;
    caller: string;
};

export type ExecutedRelayerRefundRootEvent = {
    amount_to_return: string;
    chain_id: string;
    refund_amounts: string[];
    root_bundle_id: number;
    leaf_id: number;
    l2_token_address: string;
    refund_addresses: string[];
    deferred_refunds: boolean;
    caller: string;
};

export type RelayedRootBundleEvent = {
    root_bundle_id: number;
    relayer_refund_root: string;
    slow_relay_root: string;
};

export type PausedDepositsEvent = {
    is_paused: boolean;
};

export type PausedFillsEvent = {
    is_paused: boolean;
};

export type SetXDomainAdminEvent = {
    new_admin: string;
};

export type EnabledDepositRouteEvent = {
    origin_token: string;
    destination_chain_id: string;
    enabled: boolean;
};

export type FilledRelayEvent = {
    input_token: string;
    output_token: string;
    input_amount: string;
    output_amount: string;
    repayment_chain_id: string;
    origin_chain_id: string;
    deposit_id: string;
    fill_deadline: number;
    exclusivity_deadline: number;
    exclusive_relayer: string;
    relayer: string;
    depositor: string;
    recipient: string;
    message_hash: string;
    relay_execution_info: {
        updated_recipient: string;
        updated_message_hash: string;
        updated_output_amount: string;
        fill_type: {
            FastFill: {};
        };
    };
};

export type FundsDepositedEvent = {
    input_token: string;
    output_token: string;
    input_amount: string;
    output_amount: string;
    destination_chain_id: string;
    deposit_id: string;
    quote_timestamp: number;
    fill_deadline: number;
    exclusivity_deadline: number;
    depositor: string;
    recipient: string;
    exclusive_relayer: string;
    message: {};
};

export type EmergencyDeletedRootBundleEvent = {
    root_bundle_id: number;
};

export type RequestedSlowFillEvent = {
    input_token: string;
    output_token: string;
    input_amount: string;
    output_amount: string;
    origin_chain_id: string;
    deposit_id: string;
    fill_deadline: number;
    exclusivity_deadline: number;
    exclusive_relayer: string;
    depositor: string;
    recipient: string;
    message_hash: string;
};

export type ClaimedRelayerRefundEvent = {
    l2_token_address: string;
    claim_amount: string;
    refund_address: string;
};

export type EventData =
    | BridgedToHubPoolEvent
    | TokensBridgedEvent
    | ExecutedRelayerRefundRootEvent
    | RelayedRootBundleEvent
    | PausedDepositsEvent
    | PausedFillsEvent
    | SetXDomainAdminEvent
    | EnabledDepositRouteEvent
    | FilledRelayEvent
    | FundsDepositedEvent
    | EmergencyDeletedRootBundleEvent
    | RequestedSlowFillEvent
    | ClaimedRelayerRefundEvent;

export enum SVMEventNames {
    FilledRelay = "FilledRelay",
    FundsDeposited = "FundsDeposited",
    EnabledDepositRoute = "EnabledDepositRoute",
    RelayedRootBundle = "RelayedRootBundle",
    ExecutedRelayerRefundRoot = "ExecutedRelayerRefundRoot",
    BridgedToHubPool = "BridgedToHubPool",
    PausedDeposits = "PausedDeposits",
    PausedFills = "PausedFills",
    SetXDomainAdmin = "SetXDomainAdmin",
    EmergencyDeletedRootBundle = "EmergencyDeletedRootBundle",
    RequestedSlowFill = "RequestedSlowFill",
    ClaimedRelayerRefund = "ClaimedRelayerRefund",
    TokensBridged = "TokensBridged",
}

export type EventName = keyof typeof SVMEventNames;