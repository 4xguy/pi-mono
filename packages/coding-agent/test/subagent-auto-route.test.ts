import { describe, expect, it } from "vitest";
import {
	buildAutoRouteDirective,
	getAutoRouteCommandCompletions,
	parseAutoRouteCommandArguments,
	resolveAutoRouteConfig,
	shouldInjectAutoRoutePrompt,
} from "../examples/extensions/subagent/auto-route.js";

describe("subagent auto route", () => {
	it("resolves defaults and enforces coordinator-only when auto-route is enabled", () => {
		const config = resolveAutoRouteConfig({
			defaultAutoRouteEnabled: true,
			defaultCoordinatorAgent: "coordinator",
		});

		expect(config.autoRouteEnabled).toBe(true);
		expect(config.coordinatorOnlyEnabled).toBe(true);
		expect(config.coordinatorAgent).toBe("coordinator");
	});

	it("allows explicit flag/env overrides", () => {
		const config = resolveAutoRouteConfig({
			flagAutoRoute: false,
			flagCoordinatorOnly: false,
			flagCoordinatorAgent: "lead-coordinator",
			envAutoRoute: "1",
			envCoordinatorOnly: "1",
			envCoordinatorAgent: "ignored",
			defaultAutoRouteEnabled: true,
			defaultCoordinatorAgent: "coordinator",
		});

		expect(config.autoRouteEnabled).toBe(false);
		expect(config.coordinatorOnlyEnabled).toBe(false);
		expect(config.coordinatorAgent).toBe("lead-coordinator");
	});

	it("injects only for root plain prompts and available coordinator", () => {
		const config = resolveAutoRouteConfig({
			defaultAutoRouteEnabled: true,
			defaultCoordinatorAgent: "coordinator",
		});

		expect(
			shouldInjectAutoRoutePrompt({
				config,
				prompt: "Implement milestone 4",
				depth: 0,
				hasCoordinator: true,
			}),
		).toEqual({ shouldInject: true, warnMissingCoordinator: false });

		expect(
			shouldInjectAutoRoutePrompt({
				config,
				prompt: "Implement milestone 4",
				depth: 1,
				hasCoordinator: true,
			}),
		).toEqual({ shouldInject: false, warnMissingCoordinator: false });

		expect(
			shouldInjectAutoRoutePrompt({
				config,
				prompt: "/agents",
				depth: 0,
				hasCoordinator: true,
			}),
		).toEqual({ shouldInject: false, warnMissingCoordinator: false });
	});

	it("warns and falls back when coordinator agent is missing", () => {
		const config = resolveAutoRouteConfig({
			defaultAutoRouteEnabled: true,
			defaultCoordinatorAgent: "coordinator",
		});

		const decision = shouldInjectAutoRoutePrompt({
			config,
			prompt: "Ship fix",
			depth: 0,
			hasCoordinator: false,
		});
		expect(decision).toEqual({ shouldInject: false, warnMissingCoordinator: true });
	});

	it("builds directive with explicit fallback semantics", () => {
		const directive = buildAutoRouteDirective({
			coordinatorAgent: "coordinator",
			agentScope: "project",
			contextMode: "shared-read",
			sharedContextLimit: 8,
			topologyPolicy: "auto",
		});

		expect(directive).toContain('agent "coordinator"');
		expect(directive).toContain('agentScope: "project"');
		expect(directive).toContain("sharedContextLimit: 8");
		expect(directive).toContain("continue safely in direct mode");
	});

	it("parses subagent-auto command arguments", () => {
		expect(parseAutoRouteCommandArguments("")).toEqual({ kind: "status" });
		expect(parseAutoRouteCommandArguments("on")).toEqual({ kind: "setAutoRoute", enabled: true });
		expect(parseAutoRouteCommandArguments("off")).toEqual({ kind: "setAutoRoute", enabled: false });
		expect(parseAutoRouteCommandArguments("coordinator-only on")).toEqual({
			kind: "setCoordinatorOnly",
			enabled: true,
		});
		expect(parseAutoRouteCommandArguments("coordinator-only off")).toEqual({
			kind: "setCoordinatorOnly",
			enabled: false,
		});
		expect(parseAutoRouteCommandArguments("coordinator lead-coordinator")).toEqual({
			kind: "setCoordinator",
			coordinatorAgent: "lead-coordinator",
		});
	});

	it("rejects invalid subagent-auto command arguments", () => {
		expect(parseAutoRouteCommandArguments("coordinator")).toMatchObject({ kind: "invalid" });
		expect(parseAutoRouteCommandArguments("coordinator-only maybe")).toMatchObject({ kind: "invalid" });
		expect(parseAutoRouteCommandArguments("unknown")).toMatchObject({ kind: "invalid" });
	});

	it("returns contextual subagent-auto completions", () => {
		const root = getAutoRouteCommandCompletions("", "lead-coordinator") ?? [];
		expect(root.some((item) => item.value === "on")).toBe(true);
		expect(root.some((item) => item.value === "off")).toBe(true);
		expect(root.some((item) => item.value === "coordinator-only on")).toBe(true);
		expect(root.some((item) => item.value === "coordinator lead-coordinator")).toBe(true);

		const scoped = getAutoRouteCommandCompletions("coordinator-only ", "lead-coordinator") ?? [];
		expect(scoped.map((item) => item.value)).toEqual(["coordinator-only on", "coordinator-only off"]);
	});
});
