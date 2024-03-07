const { ethers } = require('hardhat');
const { getTargetAddress } = require('../../helpers');
const marketsTree = require(`./treeMarketsAndHashes.json`);
const { BUY_IN_AMOUNT, ADDITIONAL_SLIPPAGE } = require('../../../test/constants/overtime');
const { ZERO_ADDRESS } = require('../../../test/constants/general');
const { getTradeDataItem } = require('../../../test/utils/overtime');

async function createTicket() {
	let accounts = await ethers.getSigners();
	let owner = accounts[0];
	let networkObj = await ethers.provider.getNetwork();
	let network = networkObj.name;

	console.log('Owner is:', owner.address);
	console.log('Network:', network);

	const sportsAMMV2Address = getTargetAddress('SportsAMMV2', network);
	console.log('Found SportsAMMV2 at:', sportsAMMV2Address);

	const sportsAMMV2Contract = await ethers.getContractFactory('SportsAMMV2');
	const sportsAMMV2 = sportsAMMV2Contract.attach(sportsAMMV2Address);

	const nbaMoneylineCurrentRound = marketsTree[0].childMarkets[8];
	const tradeDataCurrentRound = [];
	tradeDataCurrentRound.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));

	const quote = await sportsAMMV2.tradeQuote(tradeDataCurrentRound, BUY_IN_AMOUNT, ZERO_ADDRESS);

	console.log(quote);

	const tx = await sportsAMMV2.trade(
		tradeDataCurrentRound,
		BUY_IN_AMOUNT,
		quote.payout,
		ADDITIONAL_SLIPPAGE,
		ZERO_ADDRESS,
		ZERO_ADDRESS,
		ZERO_ADDRESS,
		false
	);

	await tx.wait().then(async () => {
		const activeTickets = await sportsAMMV2.getActiveTickets(0, 10);
		const ticketAddress = activeTickets[0];
		console.log(`Ticket with address ${ticketAddress} created`);
	});
}

createTicket()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
