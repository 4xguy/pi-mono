export type TopologyMode = "single" | "parallel" | "chain";
export type TopologyPolicy = "advisory" | "auto";

export interface ExecutionTaskItem {
	agent: string;
	task: string;
	cwd?: string;
}

export interface ExecutionPlan {
	mode: TopologyMode;
	single?: ExecutionTaskItem;
	tasks?: ExecutionTaskItem[];
	chain?: ExecutionTaskItem[];
	notes: string[];
}

export interface TopologyDecision {
	requestedMode: TopologyMode;
	recommendedMode: TopologyMode;
	selectedMode: TopologyMode;
	policy: TopologyPolicy;
	estimatedAgentCount: number;
	complexityScore: number;
	riskScore: number;
	couplingScore: number;
	confidenceScore: number;
	reasons: string[];
}

export interface TopologyDecisionInput {
	requestedMode: TopologyMode;
	singleTask?: string;
	tasks?: Array<{ task: string }>;
	chain?: Array<{ task: string }>;
}

export interface ExecutionPlanInput {
	requestedMode: TopologyMode;
	policy: TopologyPolicy;
	recommendedMode: TopologyMode;
	single?: ExecutionTaskItem;
	tasks?: ExecutionTaskItem[];
	chain?: ExecutionTaskItem[];
}

const RISK_KEYWORDS = [
	"migration",
	"database",
	"schema",
	"auth",
	"security",
	"payment",
	"delete",
	"production",
	"infra",
	"refactor",
];

export function parseTopologyPolicy(value: string | undefined, fallback: TopologyPolicy = "advisory"): TopologyPolicy {
	if (value === "auto" || value === "advisory") return value;
	return fallback;
}

export function buildTopologyDecision(input: TopologyDecisionInput): TopologyDecision {
	const taskTexts = extractTaskTexts(input);
	const estimatedAgentCount = Math.max(1, taskTexts.length);
	const avgTaskLength =
		taskTexts.length > 0 ? taskTexts.reduce((sum, task) => sum + task.length, 0) / taskTexts.length : 0;

	const complexityScore = clamp(
		Math.round(estimatedAgentCount + avgTaskLength / 120 + (input.requestedMode === "chain" ? 1 : 0)),
		1,
		10,
	);

	const keywordHits = taskTexts.reduce((hits, task) => {
		const lower = task.toLowerCase();
		const taskHits = RISK_KEYWORDS.filter((keyword) => lower.includes(keyword)).length;
		return hits + taskHits;
	}, 0);
	const riskScore = clamp(keywordHits === 0 ? 1 : 1 + keywordHits * 2, 1, 10);

	const couplingScore = input.requestedMode === "chain" ? 8 : input.requestedMode === "parallel" ? 4 : 2;

	const confidencePenalty =
		(avgTaskLength > 300 ? 2 : 0) + (riskScore >= 7 ? 2 : 0) + (estimatedAgentCount > 4 ? 1 : 0);
	const confidenceScore = clamp(8 - confidencePenalty, 1, 10);

	const recommendedMode = selectRecommendedMode({
		estimatedAgentCount,
		complexityScore,
		riskScore,
		couplingScore,
	});

	const reasons: string[] = [
		`complexity=${complexityScore}/10`,
		`risk=${riskScore}/10`,
		`coupling=${couplingScore}/10`,
		`confidence=${confidenceScore}/10`,
	];
	if (recommendedMode !== input.requestedMode) {
		reasons.push(`requested ${input.requestedMode}, policy recommends ${recommendedMode}`);
	} else {
		reasons.push(`requested mode aligns with policy (${recommendedMode})`);
	}

	return {
		requestedMode: input.requestedMode,
		recommendedMode,
		selectedMode: input.requestedMode,
		policy: "advisory",
		estimatedAgentCount,
		complexityScore,
		riskScore,
		couplingScore,
		confidenceScore,
		reasons,
	};
}

export function buildExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
	const normalized = normalizeRequestedPlan(input.requestedMode, input.single, input.tasks, input.chain);
	if (input.policy === "advisory") {
		return {
			...normalized,
			notes: ["advisory mode: requested topology kept"],
		};
	}

	const notes: string[] = [];
	switch (input.recommendedMode) {
		case "chain": {
			if (normalized.mode === "chain") {
				notes.push("auto mode: recommended topology already chain");
				return { ...normalized, notes };
			}
			if (normalized.mode === "parallel") {
				notes.push("auto mode: switched parallel -> chain for higher coupling/risk");
				return {
					mode: "chain",
					chain: (normalized.tasks ?? []).map((task) => ({ ...task })),
					notes,
				};
			}
			if (normalized.mode === "single") {
				notes.push("auto mode: switched single -> chain for higher coupling/risk");
				return {
					mode: "chain",
					chain: normalized.single ? [{ ...normalized.single }] : [],
					notes,
				};
			}
			break;
		}
		case "parallel": {
			if (normalized.mode === "parallel") {
				notes.push("auto mode: recommended topology already parallel");
				return { ...normalized, notes };
			}
			if (normalized.mode === "chain") {
				const chain = normalized.chain ?? [];
				const containsPrevious = chain.some((item) => /\{previous\}/.test(item.task));
				if (!containsPrevious && chain.length > 1) {
					notes.push("auto mode: switched chain -> parallel (no {previous} dependencies)");
					return {
						mode: "parallel",
						tasks: chain.map((task) => ({ ...task })),
						notes,
					};
				}
			}
			break;
		}
		case "single": {
			if (normalized.mode === "single") {
				notes.push("auto mode: recommended topology already single");
				return { ...normalized, notes };
			}
			if (normalized.mode === "parallel" && (normalized.tasks?.length ?? 0) === 1) {
				notes.push("auto mode: switched parallel -> single (single task)");
				return {
					mode: "single",
					single: { ...(normalized.tasks?.[0] as ExecutionTaskItem) },
					notes,
				};
			}
			if (normalized.mode === "chain" && (normalized.chain?.length ?? 0) === 1) {
				const first = normalized.chain?.[0];
				if (first && !/\{previous\}/.test(first.task)) {
					notes.push("auto mode: switched chain -> single (single independent step)");
					return {
						mode: "single",
						single: { ...first },
						notes,
					};
				}
			}
			break;
		}
	}

	notes.push("auto mode: no safe topology conversion available; using requested mode");
	return {
		...normalized,
		notes,
	};
}

function normalizeRequestedPlan(
	mode: TopologyMode,
	single: ExecutionTaskItem | undefined,
	tasks: ExecutionTaskItem[] | undefined,
	chain: ExecutionTaskItem[] | undefined,
): Omit<ExecutionPlan, "notes"> {
	if (mode === "chain") {
		return {
			mode,
			chain: (chain ?? []).map((item) => ({ ...item })),
		};
	}
	if (mode === "parallel") {
		return {
			mode,
			tasks: (tasks ?? []).map((item) => ({ ...item })),
		};
	}
	return {
		mode,
		single: single ? { ...single } : undefined,
	};
}

function extractTaskTexts(input: TopologyDecisionInput): string[] {
	if (input.requestedMode === "chain") return (input.chain ?? []).map((step) => step.task);
	if (input.requestedMode === "parallel") return (input.tasks ?? []).map((task) => task.task);
	return input.singleTask ? [input.singleTask] : [];
}

function selectRecommendedMode(input: {
	estimatedAgentCount: number;
	complexityScore: number;
	riskScore: number;
	couplingScore: number;
}): TopologyMode {
	if (input.complexityScore >= 7 || input.riskScore >= 7 || input.couplingScore >= 7) return "chain";
	if (input.estimatedAgentCount >= 2 && input.couplingScore <= 5) return "parallel";
	return "single";
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
