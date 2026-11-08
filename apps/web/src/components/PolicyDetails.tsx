import type { Exposure } from "@sortfm/contracts";
import type { ReactNode } from "react";

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="data-row">
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

function Timestamp({ value }: { value: string }) {
	return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

export function PolicyDetails({ exposure }: { exposure: Exposure | null }) {
	const telemetry = exposure?.policyTelemetry;
	const reservation = telemetry?.reservation;
	return (
		<section
			className="surface policy-details"
			aria-labelledby="policy-heading"
		>
			<div className="section-top">
				<h2 id="policy-heading">Why this song was selected</h2>
				{exposure && <span className="small-badge">SAVED EXPOSURE</span>}
			</div>
			{!exposure ? (
				<p className="fine-print">No queued song to inspect.</p>
			) : (
				<>
					<dl className="policy-identity">
						<Row label="Exposure selection method">
							<code>{exposure.selectionMethod}</code>
						</Row>
						<Row label="Policy version">
							<code>{exposure.policyVersion}</code>
						</Row>
					</dl>
					{!telemetry || !reservation ? (
						<p className="fine-print">
							Policy telemetry was not supplied for this exposure.
						</p>
					) : (
						<>
							<p className="fine-print">
								These scores describe how the policy selected this song. They
								are separate from its estimated chance of removal.
							</p>
							<div className="policy-detail-grid">
								<div>
									<dl className="policy-scores">
										{(
											[
												["Predicted review reward", telemetry.predictedReward],
												["Selection score", telemetry.selectionScore],
												["Exploration bonus", telemetry.explorationBonus],
												["Policy uncertainty radius", telemetry.uncertainty],
											] as const
										).map(([label, value]) => (
											<div key={label}>
												<dt>{label}</dt>
												<dd>{value.toFixed(3)}</dd>
											</div>
										))}
									</dl>
									<p className="fine-print">
										Uncalibrated policy quantities, not probabilities or
										confidence intervals.
									</p>
									{telemetry.reasons.length ? (
										<ul className="policy-reasons">
											{telemetry.reasons.map((reason, index) => (
												<li key={`${index}:${reason}`}>{reason}</li>
											))}
										</ul>
									) : (
										<p className="fine-print">No selection reasons supplied.</p>
									)}
								</div>
								<div className="policy-reservation">
									<h3>Reservation snapshot</h3>
									<dl>
										<Row label="Reported status">
											{
												{
													active: "Active",
													released: "Released",
													expired: "Expired",
												}[reservation.status]
											}
										</Row>
										<Row label="Reported at">
											<Timestamp value={reservation.evaluatedAt} />
										</Row>
										<Row label="Reserved at">
											<Timestamp value={reservation.reservedAt} />
										</Row>
										<Row label="Expires at">
											<Timestamp value={reservation.expiresAt} />
										</Row>
										<Row label="Closed at">
											{reservation.closedAt ? (
												<Timestamp value={reservation.closedAt} />
											) : (
												"Not closed in this snapshot"
											)}
										</Row>
										{reservation.closureReason && (
											<Row label="Closure reason">
												{
													{
														explicit_release: "Explicit release",
														undo: "Undo",
														expiry: "Expiry",
													}[reservation.closureReason]
												}
											</Row>
										)}
									</dl>
									<p className="fine-print">
										Status is reported at the time shown, not a live eligibility
										check and not proof of listening.
									</p>
								</div>
							</div>
							<details className="policy-context">
								<summary>Selection context and versions</summary>
								<dl className="policy-context-grid">
									<Row label="Policy selector">
										<code>{telemetry.selectionMethod}</code>
									</Row>
									<Row label="Strategy">
										{telemetry.strategy === "explore" ? "Explore" : "Exploit"}
									</Row>
									<Row label="Policy state version">
										<code>{telemetry.policyStateVersion}</code>
									</Row>
									<Row label="Exposure model version">
										<code>{exposure.modelVersion}</code>
									</Row>
									<Row label="Context version">
										<code>{telemetry.contextVersion}</code>
									</Row>
									<Row label="Reward version">
										<code>{telemetry.rewardVersion}</code>
									</Row>
									<Row label="Model feedback revision">
										{telemetry.modelFeedbackRevision}
									</Row>
									<Row label="Trained rewards">{telemetry.trainedRewards}</Row>
									<Row label="Candidate songs">{telemetry.candidateCount}</Row>
									<Row label="Available songs">{telemetry.availableCount}</Row>
									<Row label="Eligible songs">{telemetry.eligibleCount}</Row>
									<Row label="Information gain">
										{telemetry.informationGain.toFixed(3)}
									</Row>
									<Row label="Exposure ID">
										<code>{exposure.exposureId}</code>
									</Row>
									<Row label="Served at">
										<Timestamp value={exposure.servedAt} />
									</Row>
								</dl>
							</details>
						</>
					)}
				</>
			)}
		</section>
	);
}
