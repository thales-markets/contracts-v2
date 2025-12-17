const { ethers } = require('hardhat');
const { getTargetAddress } = require('../helpers');

async function main() {
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	if (network === 'unknown') {
		network = 'localhost';
	}

	if (network == 'homestead') {
		network = 'mainnet';
	}

	if (networkObj.chainId == 10) {
		networkObj.name = 'optimisticEthereum';
		network = 'optimisticEthereum';
	}

	if (networkObj.chainId == 11155420) {
		networkObj.name = 'optimisticSepolia';
		network = 'optimisticSepolia';
	}

	if (networkObj.chainId == 42161) {
		networkObj.name = 'arbitrumOne';
		network = 'arbitrumOne';
	}

	if (networkObj.chainId == 8453) {
		networkObj.name = 'baseMainnet';
		network = 'baseMainnet';
	}

	if (networkObj.chainId == 137) {
		networkObj.name = 'polygon';
		network = 'polygon';
	}

	let accounts = await ethers.getSigners();
	let owner = accounts[0];

	console.log('Owner is: ' + owner.address);
	console.log('Network:' + network);
	console.log('Network id:' + networkObj.chainId);

	// Get the deployed FreeBetsHolder contract
	const freeBetsHolderAddress = getTargetAddress('FreeBetsHolder', network);
	console.log('FreeBetsHolder address:', freeBetsHolderAddress);

	const FreeBetsHolder = await ethers.getContractFactory('FreeBetsHolder');
	const freeBetsHolder = await FreeBetsHolder.attach(freeBetsHolderAddress);

	// Get the default collateral address
	const defaultCollateralAddress = getTargetAddress('DefaultCollateral', network);
	console.log('Default collateral address:', defaultCollateralAddress);

	// Check user's free bet balance
	const userBalance = await freeBetsHolder.balancePerUserAndCollateral(
		owner.address,
		defaultCollateralAddress
	);
	console.log('\nUser free bet balance:', userBalance, 'USDC');

	// Check if free bet is valid
	const freeBetInfo = await freeBetsHolder.isFreeBetValid(owner.address, defaultCollateralAddress);
	console.log('Free bet is valid:', freeBetInfo.isValid);
	if (freeBetInfo.isValid) {
		console.log('Time to expiration:', freeBetInfo.timeToExpiration.toString(), 'seconds');
	} else {
		console.log('\nFree bet has expired. Cannot proceed with trade.');
		return;
	}

	// Parameters for the speed market
	const params = {
		asset: '0x4254430000000000000000000000000000000000000000000000000000000000', // BTC asset
		strikeTime: 0, // 0 for current time
		delta: 60, // 60 seconds
		strikePrice: '11692314999349',
		strikePriceSlippage: '5000000000000000', // 0.5% slippage (0.005 * 1e18)
		direction: 0, // 0 for UP
		collateral: '0xff6535c1f971245435429a915ab9eb1713bec1c1', // Use default collateral
		buyinAmount: '3820000', // 1 USDC (1e6)
		referrer: '0x0000000000000000000000000000000000000000', // No referrer
		skewImpact: 0, // No skew impact
	};

	console.log('\nCreating speed market with free bets:');
	console.log('Asset:', 'BTC');
	console.log('Strike Time:', params.strikeTime);
	console.log('Delta:', params.delta, 'seconds');
	console.log('Strike Price:', params.strikePrice, '(current price)');
	console.log('Strike Price Slippage:', params.strikePriceSlippage);
	console.log('Direction:', params.direction === 0 ? 'UP' : 'DOWN');
	console.log('Collateral:', params.collateral);
	console.log('Buy-in Amount:', params.buyinAmount, 'USDC');
	console.log('Referrer:', params.referrer);
	console.log('Skew Impact:', params.skewImpact);

	// Create transaction to trade speed market using free bets
	const tx = await freeBetsHolder.tradeSpeedMarket([
		params.asset,
		params.strikeTime,
		params.delta,
		params.strikePrice,
		params.strikePriceSlippage,
		params.direction,
		params.collateral,
		params.buyinAmount,
		params.referrer,
		params.skewImpact,
	]);

	console.log('\nTransaction hash:', tx.hash);
	const receipt = await tx.wait();
	console.log('Transaction confirmed in block:', receipt.blockNumber);

	// Check for FreeBetSpeedMarketTradeRequested event
	const tradeRequestedEvent = receipt.events?.find(
		(e) => e.event === 'FreeBetSpeedMarketTradeRequested'
	);
	if (tradeRequestedEvent) {
		console.log('\nSpeed market trade requested successfully!');
		console.log('Request ID:', tradeRequestedEvent.args.requestId);
		console.log('User:', tradeRequestedEvent.args.user);
		console.log(
			'Buy-in amount:',
			ethers.utils.formatUnits(tradeRequestedEvent.args.buyInAmount, 6),
			'USDC'
		);
		console.log('Asset:', ethers.utils.parseBytes32String(tradeRequestedEvent.args.asset));
		console.log('Strike time:', tradeRequestedEvent.args.strikeTime.toString());
		console.log('Direction:', tradeRequestedEvent.args.direction === 0 ? 'UP' : 'DOWN');
	}

	// Check updated free bet balance
	const newBalance = await freeBetsHolder.balancePerUserAndCollateral(
		owner.address,
		defaultCollateralAddress
	);
	console.log('\nUpdated free bet balance:', newBalance, 'USDC');

	// Get active tickets for the user
	const numActiveTickets = await freeBetsHolder.numOfActiveTicketsPerUser(owner.address);
	console.log('Number of active tickets:', numActiveTickets.toString());

	console.log('\nScript completed successfully!');
	console.log(
		'Note: The speed market will be created by the SpeedMarketsAMMCreator and confirmed via confirmSpeedOrChainedSpeedMarketTrade callback.'
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
