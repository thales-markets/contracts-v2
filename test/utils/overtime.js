const { TYPE_ID_SPREAD, TYPE_ID_TOTAL, TYPE_ID_POINTS } = require('../constants/overtime');
const markets = require(`../../scripts/deployOvertime/updateMerkleTree/markets.json`);
const { ONE_DAY_IN_SECS, ONE_WEEK_IN_SECS } = require('../constants/general');
const { getMerkleTree } = require('./merkleTree/merkleTree');
const fs = require('fs');

const getTradeDataItem = (market, position) => {
	return {
		gameId: market.gameId,
		sportId: market.sportId,
		typeId: market.typeId,
		maturity: market.maturity,
		status: market.status,
		line: market.line,
		playerId: market.playerProps.playerId,
		odds: market.odds,
		merkleProof: market.proof,
		position: position,
		combinedPositions: market.combinedPositions || new Array(market.odds.length).fill([]),
	};
};

const getTicketTradeData = () => {
	const marketsTree = require(`./merkleTree/treeMarketsAndHashes.json`);
	const nbaMoneylineCurrentRound = marketsTree[0];
	const nbaMoneylineNextRound = marketsTree[1];
	const nbaSpreadNextRound = marketsTree[1].childMarkets[0];

	const tradeDataCurrentRound = [];
	tradeDataCurrentRound.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));

	const tradeDataNextRound = [];
	tradeDataNextRound.push(getTradeDataItem(nbaMoneylineNextRound, 0));

	const tradeDataCrossRounds = [];
	tradeDataCrossRounds.push(getTradeDataItem(nbaMoneylineCurrentRound, 0));
	tradeDataCrossRounds.push(getTradeDataItem(nbaSpreadNextRound, 1));

	return { tradeDataCurrentRound, tradeDataNextRound, tradeDataCrossRounds };
};

const createMerkleTree = async () => {
	const marketInCurrentRound = markets[0];
	const marketInCrossRounds = markets[1];

	const today = Math.round(new Date().getTime() / 1000);
	const tomorrow = today + ONE_DAY_IN_SECS;
	const nextWeek = tomorrow + ONE_WEEK_IN_SECS;

	marketInCurrentRound.maturity = tomorrow;
	marketInCurrentRound.childMarkets.forEach((childMarket) => {
		childMarket.maturity = tomorrow;
	});

	marketInCrossRounds.maturity = nextWeek;
	marketInCrossRounds.childMarkets.forEach((childMarket) => {
		childMarket.maturity = nextWeek;
	});

	const newMarkets = [marketInCurrentRound, marketInCrossRounds];

	const { root, treeMarketsAndHashes } = await getMerkleTree(newMarkets);

	fs.writeFileSync(
		`test/utils/merkleTree/treeMarketsAndHashes.json`,
		JSON.stringify(treeMarketsAndHashes),
		function (err) {
			if (err) return console.log(err);
		}
	);

	return root;
};

module.exports = {
	getTicketTradeData,
	getTradeDataItem,
	createMerkleTree,
};
