export function AutoplayToggle({
	checked,
	onChange,
}: {
	checked: boolean;
	onChange: (enabled: boolean) => void;
}) {
	return (
		<label className="autoplay-toggle">
			<span>Autoplay</span>
			<input
				type="checkbox"
				role="switch"
				aria-checked={checked}
				aria-label="Play each new song"
				checked={checked}
				onChange={(event) => onChange(event.currentTarget.checked)}
			/>
			<span className="autoplay-track" aria-hidden="true">
				<span />
			</span>
			<span className="autoplay-state" aria-hidden="true">
				{checked ? "On" : "Off"}
			</span>
		</label>
	);
}
