// Browser-side theme plugin (dsh module loader format). Registers the
// cybergreen dark theme with the client theme service (provided by
// @deepseek-ai/dsh-client-ui-theme) and activates it on first load unless the
// user already picked a preference — third-party ids are not persisted by
// dsh, so after a restart the theme stays selectable in Settings > Appearance
// and is re-applied on load only when the preference is still the default.
window.__ModuleLoader__.load({
	id: "dsh-theme-cybergreen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const TOKENS = {
			// bg 层：近黑墨绿
			"--dsw-alias-bg-base": "#0a100d",
			"--dsw-alias-bg-layer-1": "#0f1812",
			"--dsw-alias-bg-layer-2": "#152119",
			"--dsw-alias-bg-overlay": "#0c130f",
			"--dsw-specific-sidebar-fill": "#0b120e",
			// border 层：墨绿描边
			"--dsw-alias-border-l1": "#1d3225",
			"--dsw-alias-border-l2": "#2a4a36",
			// brand 层：荧光绿
			"--dsw-alias-brand-primary": "#00ff66",
			// label 层：绿调文字
			"--dsw-alias-label-primary": "#e9fff2",
			"--dsw-alias-label-secondary": "#7dab8f",
			// state 层：霓虹状态色
			"--dsw-alias-state-error-primary": "#ff2e5f",
			"--dsw-alias-state-success-primary": "#31ffa1",
			"--dsw-alias-state-warn-primary": "#ffc533",
		};

		exports.inject = ["theme"];

		exports.apply = function apply(ctx) {
			const theme = ctx.theme;
			const dispose = theme.register({
				id: "cybergreen",
				colorScheme: "dark",
				tokens: TOKENS,
			});
			// 主题注册随插件生命周期回收；停用时若偏好仍是 cybergreen 会自动回落 system
			ctx.effect(() => dispose);
			// 仅当用户尚未自选偏好时激活，避免覆盖手动选择
			if (theme.getTheme().preference === "system") {
				theme.setTheme("cybergreen");
			}
		};

		return module.exports;
	}
});
