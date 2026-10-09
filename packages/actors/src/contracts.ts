/**
 * behaviour contracts per agent type, ported from cmx (`agent/behaviors.ts`). a contract names what
 * the spawner expects back and which ABORT reasons the type may end with. validation runs when a turn
 * ends, never at spawn: a violation rides the report as data and the spawner decides what to do.
 *
 * cmx2 changes one thing: a child no longer has to call a send tool to deliver. its final text is the
 * report, so `report_required` is met by a substantive final text or an explicit message to the spawner.
 */

/** the ABORT set phrase a child may end its final text with, on its last line */
export const ABORT_REASONS = ["spec_wrong", "transient_tool_error", "out_of_scope", "context_full", "approach_failed", "user_question"] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

export type ContractVersion = "subagent_v1" | "subagent_v2";

export type ViolationKind = "missing_delivery" | "undeclared_failure_mode" | "invalid_termination" | "output_shape_mismatch";

export interface BehaviorContract {
	version: ContractVersion;
	/** report_required: a substantive final text or a message to the spawner; report_optional and no_delivery never flag */
	delivery: "report_required" | "report_optional" | "no_delivery";
	declared_failure_modes: readonly string[];
	expected_outputs?: { kind: "free_text" | "json_schema"; schema?: unknown };
}

export interface BehaviorViolation {
	kind: ViolationKind;
	detail: string;
}

const generalV1: BehaviorContract = { version: "subagent_v1", delivery: "report_required", declared_failure_modes: ABORT_REASONS };
/** forward-compatible version; coexists with v1 under the same type */
const generalV2: BehaviorContract = { version: "subagent_v2", delivery: "report_required", declared_failure_modes: ABORT_REASONS, expected_outputs: { kind: "free_text" } };
/** explore does not iterate on an approach, so approach_failed is outside its set */
const exploreV1: BehaviorContract = {
	version: "subagent_v1",
	delivery: "report_required",
	declared_failure_modes: ["spec_wrong", "transient_tool_error", "out_of_scope", "context_full", "user_question"],
};

export const DEFAULT_CONTRACTS: Record<string, { default_version: ContractVersion; versions: Partial<Record<ContractVersion, BehaviorContract>> }> = {
	general: { default_version: "subagent_v1", versions: { subagent_v1: generalV1, subagent_v2: generalV2 } },
	explore: { default_version: "subagent_v1", versions: { subagent_v1: exploreV1 } },
};

/** undefined for an unregistered type or version: no contract, no validation */
export function resolveContract(agentType?: string, version?: string): BehaviorContract | undefined {
	if (agentType === undefined) return undefined;
	const entry = DEFAULT_CONTRACTS[agentType];
	if (!entry) return undefined;
	return entry.versions[(version ?? entry.default_version) as ContractVersion];
}

export function computeViolations(contract: BehaviorContract | undefined, observed: { delivered: boolean; abort?: { reason: string; details: string } }): BehaviorViolation[] {
	if (!contract) return [];
	const out: BehaviorViolation[] = [];
	if (contract.delivery === "report_required" && !observed.delivered) {
		out.push({ kind: "missing_delivery", detail: "the child ended its turn without a substantive final text or a message to its spawner" });
	}
	if (observed.abort && !contract.declared_failure_modes.includes(observed.abort.reason)) {
		out.push({ kind: "undeclared_failure_mode", detail: `ABORT reason ${observed.abort.reason} is not one this agent type declares` });
	}
	return out;
}
