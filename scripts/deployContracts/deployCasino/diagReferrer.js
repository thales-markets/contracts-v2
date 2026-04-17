const { ethers } = require('hardhat');
const all = require('../../deployments.json');

const USER = '0xf12c220b631125425f4c69823d6187FE3C8d0999';
const EXPECTED_REFERRER = '0xe966C59c15566A994391F6226fee5bc0eF70F87A';

async function main() {
	const networkObj = await ethers.provider.getNetwork();
	const network = networkObj.name;
	const addrs = all[network];
	console.log(`Network: ${network} (chain ${networkObj.chainId})`);
	console.log(`User:              ${USER}`);
	console.log(`Expected referrer: ${EXPECTED_REFERRER}\n`);

	// Referrals contract
	const referralsAddr = addrs.Referrals;
	console.log(`Referrals: ${referralsAddr}`);
	const referralsAbi = [
		'function referrals(address) view returns (address)',
		'function getReferrerFee(address) view returns (uint256)',
		'function whitelistedAddresses(address) view returns (bool)',
		'function owner() view returns (address)',
	];
	const referrals = new ethers.Contract(referralsAddr, referralsAbi, ethers.provider);

	const currentReferrer = await referrals.referrals(USER);
	console.log(`referrals.referrals(user) = ${currentReferrer}`);
	console.log(
		`  matches expected? ${currentReferrer.toLowerCase() === EXPECTED_REFERRER.toLowerCase()}`
	);

	try {
		const fee = await referrals.getReferrerFee(EXPECTED_REFERRER);
		console.log(`getReferrerFee(expectedReferrer) = ${fee.toString()}  (${Number(fee) / 1e16}%)`);
	} catch (e) {
		console.log(`getReferrerFee error: ${(e.message || e).slice(0, 100)}`);
	}
	if (
		currentReferrer !== ethers.ZeroAddress &&
		currentReferrer.toLowerCase() !== EXPECTED_REFERRER.toLowerCase()
	) {
		try {
			const fee = await referrals.getReferrerFee(currentReferrer);
			console.log(
				`getReferrerFee(actualReferrer ${currentReferrer}) = ${fee.toString()}  (${
					Number(fee) / 1e16
				}%)`
			);
		} catch (e) {}
	}

	// Casino contracts: does each have referrals wired?
	console.log('\n--- Casino.referrals() wiring ---');
	const games = ['Dice', 'Roulette', 'Blackjack', 'Baccarat', 'Slots'];
	for (const name of games) {
		const a = addrs[name];
		if (!a) continue;
		try {
			const c = await ethers.getContractAt(name, a);
			const ref = await c.referrals();
			const match = ref.toLowerCase() === referralsAddr.toLowerCase();
			console.log(`${name.padEnd(10)} referrals()=${ref}  wired=${match}`);
		} catch (e) {
			console.log(`${name.padEnd(10)} referrals() error: ${(e.message || e).slice(0, 80)}`);
		}
	}

	// Is each casino whitelisted in Referrals? (so setReferrer can actually record)
	console.log('\n--- Referrals.whitelistedAddresses(casino) ---');
	for (const name of games) {
		const a = addrs[name];
		if (!a) continue;
		try {
			const wl = await referrals.whitelistedAddresses(a);
			console.log(`${name.padEnd(10)} ${a}  whitelistedInReferrals=${wl}`);
		} catch (e) {
			console.log(`${name.padEnd(10)} whitelist check error: ${(e.message || e).slice(0, 80)}`);
		}
	}

	// User bet history per casino: LOST bets only (these would pay the referrer)
	console.log('\n--- User bet history (lost bets trigger referrer payment) ---');
	for (const name of games) {
		const a = addrs[name];
		if (!a) continue;
		try {
			const c = await ethers.getContractAt(name, a);
			let count;
			try {
				count = await c.getUserBetCount(USER);
			} catch {
				console.log(`${name.padEnd(10)} no getUserBetCount — skip`);
				continue;
			}
			if (count === 0n) {
				console.log(`${name.padEnd(10)} 0 bets`);
				continue;
			}
			const ids = await c.getUserBetIds(USER, 0, Number(count));
			let lost = 0;
			let won = 0;
			let pending = 0;
			let cancelled = 0;
			let totalLostStake = 0n;
			for (const id of ids) {
				const base = await c.getBetBase(id);
				const isFree = await c.isFreeBet(id);
				// status: from getBetDetails if available
				let status;
				try {
					const d = await c.getBetDetails(id);
					status = Number(d.status);
				} catch {
					status = null;
				}
				if (status === 1) pending++;
				else if (status === 3) cancelled++;
				else if (base.payout === 0n) {
					lost++;
					if (!isFree) totalLostStake += base.amount;
				} else won++;
			}
			console.log(
				`${name.padEnd(
					10
				)} bets=${count}  won=${won} lost=${lost} cancelled=${cancelled} pending=${pending}  nonFreeLostStake=${totalLostStake}`
			);
		} catch (e) {
			console.log(`${name.padEnd(10)} history error: ${(e.message || e).slice(0, 100)}`);
		}
	}

	// Check ReferrerPaid event from Roulette for this user (recent blocks)
	console.log('\n--- Scan Roulette for ReferrerPaid events (last ~500k blocks) ---');
	try {
		const rouletteAddr = addrs.Roulette;
		const rabi = [
			'event ReferrerPaid(address indexed referrer, address indexed user, uint amount, uint betAmount, address collateral)',
		];
		const r = new ethers.Contract(rouletteAddr, rabi, ethers.provider);
		const latest = await ethers.provider.getBlockNumber();
		const from = Math.max(0, latest - 500000);
		const logs = await r.queryFilter(r.filters.ReferrerPaid(null, USER), from, latest);
		console.log(`Roulette ReferrerPaid events for user: ${logs.length}`);
		for (const l of logs) {
			console.log(
				`  block ${l.blockNumber}  referrer=${
					l.args.referrer
				}  amount=${l.args.amount.toString()}  betAmount=${l.args.betAmount.toString()}`
			);
		}
	} catch (e) {
		console.log(`ReferrerPaid scan error: ${(e.message || e).slice(0, 120)}`);
	}
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
