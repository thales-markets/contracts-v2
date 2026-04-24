// Measures VRF callback gas for the various split paths so we can set
// callbackGasLimit correctly. Excluded from default test run.
const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');
const { upgrades, ethers } = require('hardhat');

const WETH_KEY = ethers.encodeBytes32String('WETH');
const OVER_KEY = ethers.encodeBytes32String('OVER');

function makeDealWord(r0, r1 = 1) {
	const high = BigInt((((r1 - 1) % 13) + 13) % 13);
	const target = BigInt((((r0 - 1) % 13) + 13) % 13);
	const low = (target - 9n * high + 169n) % 13n;
	return low | (high << 128n);
}
function makeSingleWord(r) {
	return BigInt((((r - 1) % 13) + 13) % 13);
}

async function parseHandCreated(bj, tx) {
	const rc = await tx.wait();
	const ev = rc.logs
		.map((l) => {
			try {
				return bj.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === 'HandCreated');
	return { handId: ev.args.handId, requestId: ev.args.requestId };
}
async function parseRequestId(bj, tx, name) {
	const rc = await tx.wait();
	const ev = rc.logs
		.map((l) => {
			try {
				return bj.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e) => e?.name === name);
	return ev.args.requestId;
}

async function deployFixture() {
	const [owner, player] = await ethers.getSigners();
	const USDC = await ethers.getContractFactory('ExoticUSDC');
	const usdc = await USDC.deploy();
	for (let i = 0; i < 20; i++) await usdc.mintForUser(owner.address);
	const USD = await ethers.getContractFactory('ExoticUSD');
	const weth = await USD.deploy();
	const over = await USD.deploy();
	const PF = await ethers.getContractFactory('MockPriceFeed');
	const pf = await PF.deploy();
	await pf.setPriceFeedForCollateral(WETH_KEY, await weth.getAddress(), ethers.parseEther('3000'));
	await pf.setPriceFeedForCollateral(OVER_KEY, await over.getAddress(), ethers.parseEther('1'));
	const Mgr = await ethers.getContractFactory('SportsAMMV2Manager');
	const mgr = await upgrades.deployProxy(Mgr, [owner.address]);
	const VRF = await ethers.getContractFactory('MockVRFCoordinator');
	const vrf = await VRF.deploy();
	const BJ = await ethers.getContractFactory('Blackjack');
	const bj = await upgrades.deployProxy(BJ, [], { initializer: false });
	await bj.initialize(
		{
			owner: owner.address,
			manager: await mgr.getAddress(),
			priceFeed: await pf.getAddress(),
			vrfCoordinator: await vrf.getAddress(),
		},
		{
			usdc: await usdc.getAddress(),
			weth: await weth.getAddress(),
			over: await over.getAddress(),
			wethPriceFeedKey: WETH_KEY,
			overPriceFeedKey: OVER_KEY,
		},
		ethers.parseEther('1000'),
		3600n,
		{
			subscriptionId: 1,
			keyHash: ethers.ZeroHash,
			callbackGasLimit: 500000,
			requestConfirmations: 3,
			nativePayment: false,
		}
	);
	await usdc.transfer(await bj.getAddress(), 500n * 1_000_000n);
	await usdc.transfer(player.address, 500n * 1_000_000n);
	return { owner, player, usdc, bj, vrf };
}

describe('Blackjack callback gas', () => {
	it('measures gas across all VRF fulfillment paths', async () => {
		const { player, usdc, bj, vrf } = await loadFixture(deployFixture);
		const bjAddr = await bj.getAddress();
		const usdcAddr = await usdc.getAddress();
		const AMT = 3_000_000n;

		async function fresh(c1, c2, dUp, dHidden) {
			await usdc.connect(player).approve(bjAddr, AMT * 4n);
			const tx = await bj.connect(player).placeBet(usdcAddr, AMT, ethers.ZeroAddress);
			const { handId, requestId } = await parseHandCreated(bj, tx);
			const rc = await vrf.fulfillRandomWords(bjAddr, requestId, [
				makeDealWord(c1, dUp),
				makeDealWord(c2, dHidden),
			]);
			const r = await rc.wait();
			return { handId, dealGas: r.gasUsed };
		}

		console.log('\n=== Blackjack VRF fulfillment gas by path ===');

		// 1. Simple deal (no BJ)
		{
			const { dealGas } = await fresh(5, 6, 4, 3);
			console.log(`  deal (simple, goes to PLAYER_TURN):           ${dealGas}`);
		}

		// 2. Deal → natural BJ resolve
		{
			await usdc.connect(player).approve(bjAddr, AMT);
			const tx = await bj.connect(player).placeBet(usdcAddr, AMT, ethers.ZeroAddress);
			const { requestId } = await parseHandCreated(bj, tx);
			const rc = await vrf.fulfillRandomWords(bjAddr, requestId, [
				makeDealWord(1, 4),
				makeDealWord(10, 3),
			]);
			const r = await rc.wait();
			console.log(`  deal → player BJ, auto-resolve:               ${r.gasUsed}`);
		}

		// 3. Hit, non-split, lands below 21
		{
			const { handId } = await fresh(5, 6, 4, 3);
			const hitTx = await bj.connect(player).hit(handId);
			const hitReq = await parseRequestId(bj, hitTx, 'HitRequested');
			const rc = await vrf.fulfillRandomWords(bjAddr, hitReq, [makeSingleWord(5)]);
			const r = await rc.wait();
			console.log(`  hit (simple, non-split, not bust, <21):       ${r.gasUsed}`);
		}

		// 4. Hit, non-split, busts (resolve)
		{
			const { handId } = await fresh(10, 9, 4, 3); // 19
			const hitTx = await bj.connect(player).hit(handId);
			const hitReq = await parseRequestId(bj, hitTx, 'HitRequested');
			const rc = await vrf.fulfillRandomWords(bjAddr, hitReq, [makeSingleWord(5)]); // 24
			const r = await rc.wait();
			console.log(`  hit (non-split, busts, auto-resolve):         ${r.gasUsed}`);
		}

		// 5. Hit, non-split, lands on 21 — auto-stand triggers dealer VRF
		{
			const { handId } = await fresh(5, 6, 4, 3); // 11
			const hitTx = await bj.connect(player).hit(handId);
			const hitReq = await parseRequestId(bj, hitTx, 'HitRequested');
			const rc = await vrf.fulfillRandomWords(bjAddr, hitReq, [makeSingleWord(10)]); // 21
			const r = await rc.wait();
			console.log(`  hit (non-split, lands 21, nested VRF req):    ${r.gasUsed}`);
		}

		// 6. Stand, non-split — dealer plays
		{
			const { handId } = await fresh(10, 9, 4, 3);
			const sTx = await bj.connect(player).stand(handId);
			const sReq = await parseRequestId(bj, sTx, 'StandRequested');
			const rc = await vrf.fulfillRandomWords(bjAddr, sReq, [
				makeSingleWord(10),
				makeSingleWord(5),
				0n,
				0n,
				0n,
				0n,
				0n,
			]);
			const r = await rc.wait();
			console.log(`  stand (non-split, dealer plays 7 words):      ${r.gasUsed}`);
		}

		// 7. Double, non-split — dealer plays
		{
			const { handId } = await fresh(5, 6, 4, 3);
			await usdc.connect(player).approve(bjAddr, AMT);
			const dTx = await bj.connect(player).doubleDown(handId);
			const dReq = await parseRequestId(bj, dTx, 'DoubleDownRequested');
			const rc = await vrf.fulfillRandomWords(bjAddr, dReq, [
				makeSingleWord(4),
				makeSingleWord(10),
				makeSingleWord(5),
				0n,
				0n,
				0n,
				0n,
			]);
			const r = await rc.wait();
			console.log(`  doubleDown (non-split, resolves in callback): ${r.gasUsed}`);
		}

		// 8. Split deal (non-ace)
		{
			const { handId } = await fresh(8, 8, 4, 3);
			await usdc.connect(player).approve(bjAddr, AMT);
			const splitTx = await bj.connect(player).split(handId);
			const splitReq = await parseRequestId(bj, splitTx, 'HandSplit');
			const rc = await vrf.fulfillRandomWords(bjAddr, splitReq, [
				makeSingleWord(3),
				makeSingleWord(5),
			]);
			const r = await rc.wait();
			console.log(`  split deal (non-ace, 2 words):                ${r.gasUsed}`);
		}

		// 9. Ace-split deal (auto-resolves 9-word callback)
		{
			const { handId } = await fresh(1, 1, 4, 3);
			await usdc.connect(player).approve(bjAddr, AMT);
			const splitTx = await bj.connect(player).split(handId);
			const splitReq = await parseRequestId(bj, splitTx, 'HandSplit');
			const rc = await vrf.fulfillRandomWords(bjAddr, splitReq, [
				makeSingleWord(10),
				makeSingleWord(5),
				makeSingleWord(10),
				makeSingleWord(3),
				0n,
				0n,
				0n,
				0n,
				0n,
			]);
			const r = await rc.wait();
			console.log(`  ace-split auto-resolve (9 words, dealer+both):${r.gasUsed}`);
		}

		// 10. *** Split hit on hand 1, then hit on hand 2 that BUSTS → nested dealer VRF ***
		{
			const { handId } = await fresh(8, 8, 4, 3);
			await usdc.connect(player).approve(bjAddr, AMT);
			const splitTx = await bj.connect(player).split(handId);
			const splitReq = await parseRequestId(bj, splitTx, 'HandSplit');
			await vrf.fulfillRandomWords(bjAddr, splitReq, [makeSingleWord(3), makeSingleWord(5)]);
			// stand hand1 → activeHand = 2 (synchronous)
			await bj.connect(player).stand(handId);
			// hit hand 2 → 8+5+10 = 23 bust
			const hitTx = await bj.connect(player).hit(handId);
			const hitReq = await parseRequestId(bj, hitTx, 'HitRequested');
			const rc = await vrf.fulfillRandomWords(bjAddr, hitReq, [makeSingleWord(10)]);
			const r = await rc.wait();
			console.log(
				`  ★ split h2 hit busts, nested dealer VRF req: ${r.gasUsed}  ← the failing path`
			);
		}

		// 11. Split h2 hit lands on 21 (auto-stand, nested dealer VRF req)
		{
			const { handId } = await fresh(8, 8, 4, 3);
			await usdc.connect(player).approve(bjAddr, AMT);
			const splitTx = await bj.connect(player).split(handId);
			const splitReq = await parseRequestId(bj, splitTx, 'HandSplit');
			await vrf.fulfillRandomWords(bjAddr, splitReq, [makeSingleWord(3), makeSingleWord(5)]);
			await bj.connect(player).stand(handId);
			// hit hand 2: 8+5+8 = 21 → auto-stand, nested dealer VRF
			const hitTx = await bj.connect(player).hit(handId);
			const hitReq = await parseRequestId(bj, hitTx, 'HitRequested');
			const rc = await vrf.fulfillRandomWords(bjAddr, hitReq, [makeSingleWord(8)]);
			const r = await rc.wait();
			console.log(`  ★ split h2 hit lands 21, nested dealer VRF:  ${r.gasUsed}`);
		}

		// 12. Split + final stand on hand 2 (dealer plays)
		{
			const { handId } = await fresh(8, 8, 4, 3);
			await usdc.connect(player).approve(bjAddr, AMT);
			const splitTx = await bj.connect(player).split(handId);
			const splitReq = await parseRequestId(bj, splitTx, 'HandSplit');
			await vrf.fulfillRandomWords(bjAddr, splitReq, [makeSingleWord(3), makeSingleWord(5)]);
			await bj.connect(player).stand(handId);
			const sTx = await bj.connect(player).stand(handId);
			const sReq = await parseRequestId(bj, sTx, 'StandRequested');
			const rc = await vrf.fulfillRandomWords(bjAddr, sReq, [
				makeSingleWord(10),
				makeSingleWord(5),
				0n,
				0n,
				0n,
				0n,
				0n,
			]);
			const r = await rc.wait();
			console.log(`  split h2 stand, dealer plays, resolve both:   ${r.gasUsed}`);
		}

		console.log('');
	}).timeout(120_000);
});
