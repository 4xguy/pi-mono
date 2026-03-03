import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.js";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

describe("Editor slash autocomplete tab behavior", () => {
	it("shows argument completions immediately after tab-completing a slash command name", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const provider = new CombinedAutocompleteProvider([
			{
				name: "memory-mode",
				description: "Set memory mode",
				getArgumentCompletions: (prefix: string) => {
					const options = ["auto", "strict", "off"];
					const normalized = prefix.trim().toLowerCase();
					const filtered = normalized.length ? options.filter((option) => option.startsWith(normalized)) : options;
					return filtered.map((option) => ({
						value: option,
						label: option,
					}));
				},
			},
		]);
		editor.setAutocompleteProvider(provider);

		for (const ch of "/memory-m") {
			editor.handleInput(ch);
		}

		editor.handleInput("\t");
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		editor.handleInput("\t");
		assert.strictEqual(editor.getText(), "/memory-mode ");
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		editor.handleInput("\t");
		assert.strictEqual(editor.getText(), "/memory-mode auto");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});
});
