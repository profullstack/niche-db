import { defineAdapter } from '@nichedb/core/adapter';

/** Reviewed against the linked primary documentation, not a live availability promise. */
export const BLOCKCHAIN_PROVIDERS = [
  {
    id: 'blockstream-esplora',
    name: 'Blockstream Esplora',
    url: 'https://blockstream.info',
    docs: 'https://github.com/Blockstream/esplora/blob/master/API.md',
    chains: ['btc', 'liquid'],
    features: ['utxos', 'balances', 'transactions', 'broadcast', 'fees'],
    endpoints: [
      'https://blockstream.info/api',
      'https://blockstream.info/testnet/api',
      'https://blockstream.info/testnet4/api',
      'https://blockstream.info/liquid/api',
    ],
    summary:
      'Keyless Bitcoin and Liquid REST APIs for address UTXOs, balances, transaction hex, fee estimates and broadcasting locally signed transactions. Amounts are integer satoshis. The open-source server can also be self-hosted.',
    limits:
      'Shared public infrastructure with no production SLA. Cache immutable transaction data, handle throttling, and use failover or your own Esplora instance for sustained traffic.',
  },
  {
    id: 'mempool-space',
    name: 'Mempool.space',
    url: 'https://mempool.space',
    docs: 'https://mempool.space/docs/api/rest',
    chains: ['btc'],
    features: ['utxos', 'balances', 'transactions', 'broadcast', 'fees'],
    endpoints: ['https://mempool.space/api', 'https://mempool.space/testnet/api'],
    summary:
      'Public Bitcoin REST API with recommended fees, mempool information and Esplora-compatible address and transaction endpoints. A keyless companion to Blockstream for BTC payment integrations.',
    limits:
      'Rate limits apply. HTTP 429 means slow down; repeatedly exceeding the limits can lead to a ban. Higher limits are offered separately through enterprise sponsorship.',
  },
  {
    id: 'publicnode',
    name: 'PublicNode',
    url: 'https://www.publicnode.com',
    docs: 'https://www.publicnode.com',
    chains: ['eth', 'pol', 'bnb', 'sol'],
    features: ['rpc', 'balances', 'transactions', 'broadcast', 'gas-prices'],
    endpoints: [
      'https://ethereum-rpc.publicnode.com',
      'https://polygon-bor-rpc.publicnode.com',
      'https://bsc-rpc.publicnode.com',
      'https://solana-rpc.publicnode.com',
    ],
    summary:
      'Free public RPC endpoints across many networks, including Ethereum, Polygon, BNB Chain and Solana. EVM JSON-RPC methods provide balances, transaction receipts, gas prices and signed-transaction broadcasting.',
    limits:
      'Shared endpoints rather than a dedicated service. Consult the provider terms, handle throttling and transport failures, and verify that the methods your application needs are enabled.',
  },
  {
    id: 'kraken-public-market-data',
    name: 'Kraken public market data',
    url: 'https://docs.kraken.com/api-reference/market-data/get-ticker-information',
    docs: 'https://docs.kraken.com/api-reference/market-data/get-ticker-information',
    chains: ['btc', 'eth', 'pol', 'sol', 'bch', 'doge', 'xrp', 'ada', 'bnb'],
    features: ['prices', 'markets'],
    endpoints: ['https://api.kraken.com/0/public/Ticker'],
    summary:
      'Keyless spot-market tickers for supported trading pairs: last trade, bid, ask, volume and daily high and low. Useful for crypto payment quotes; this is exchange market data rather than an on-chain wallet API.',
    limits:
      'Use supported AssetPairs and cache quotes. A venue price represents that exchange, and public API rate limits still apply. Wallet balances and UTXOs require a separate chain data source.',
  },
  {
    id: 'koios',
    name: 'Koios Cardano API',
    url: 'https://www.koios.rest',
    docs: 'https://api.koios.rest',
    pricingDocs: 'https://koios.rest/tiers.html',
    chains: ['ada'],
    features: ['utxos', 'balances', 'transactions', 'assets'],
    endpoints: ['https://api.koios.rest/api/v1'],
    summary:
      'Distributed Cardano REST query layer for addresses, UTXOs, transactions and native assets. The public tier needs no key; an optional registered free tier increases the daily allowance.',
    limits:
      'Published public allowance: 5,000 requests per day and 100 requests per 10 seconds, with restricted CORS. The registered free tier offers 50,000 per day with a token and open CORS. Verify current limits before integrating.',
    publicRequestsPerDay: 5000,
    registeredFreeRequestsPerDay: 50000,
  },
  {
    id: 'xrpl-public-servers',
    name: 'XRPL public servers',
    url: 'https://xrpl.org/docs/tutorials/public-servers',
    docs: 'https://xrpl.org/docs/tutorials/public-servers',
    chains: ['xrp'],
    features: ['rpc', 'balances', 'transactions', 'broadcast', 'fees'],
    endpoints: ['wss://xrplcluster.com', 'wss://s1.ripple.com'],
    summary:
      'Public XRP Ledger WebSocket and JSON-RPC services for validated-ledger account data, fees, transaction status and submitting locally signed transactions. Server history and capabilities vary.',
    limits:
      'Public servers can limit requests and are not dedicated infrastructure. Select the history and methods your application requires; validate ledger status and use more than one server.',
  },
  {
    id: 'solana-public-rpc',
    name: 'Solana public RPC',
    url: 'https://solana.com/docs/references/clusters',
    docs: 'https://solana.com/docs/references/clusters',
    chains: ['sol'],
    features: ['rpc', 'balances', 'transactions', 'broadcast', 'fees'],
    endpoints: ['https://api.mainnet.solana.com', 'https://api.devnet.solana.com'],
    summary:
      'Official public Solana RPC endpoints for development and light querying. The API exposes account balances, transaction information, blockhashes and signed-transaction submission.',
    limits:
      'Solana explicitly says its shared public endpoints are not intended for production applications. Rate limits may change and high-traffic sites can be blocked; use a suitable RPC provider for payment production traffic.',
    productionRecommended: false,
  },
];

export function blockchainProviderItem(provider) {
  return {
    externalId: `blockchain-api:${provider.id}`,
    kind: 'api-provider',
    title: provider.name,
    url: provider.url,
    summary: `${provider.summary} ${provider.limits} Documentation: ${provider.docs}`,
    timeKnown: false,
    tags: [
      'free',
      'keyless',
      ...provider.chains.map((chain) => `chain:${chain}`),
      ...provider.features.map((feature) => `feature:${feature}`),
    ],
    data: {
      ...provider,
      apiKeyRequired: false,
      freeAccess: true,
      reviewedOn: '2026-10-31',
      reviewScope: 'Provider documentation; no uptime or unlimited-use guarantee.',
    },
  };
}

export const blockchainProviders = defineAdapter({
  name: 'blockchain-providers',
  title: 'Free blockchain API providers',
  collection: 'blockchain',
  description:
    'A curated directory of free public blockchain APIs, with supported chains, capabilities, endpoints, documentation and free-tier constraints. These are provider records, not cached wallet balances or transaction execution.',
  docs: 'https://github.com/profullstack/niche-db',
  kinds: ['api-provider'],
  cadenceMinutes: 1440,
  defaultSources: [{ slug: 'blockchain-free-apis', name: 'Blockchain: free public APIs' }],
  async pull() {
    return {
      items: BLOCKCHAIN_PROVIDERS.map(blockchainProviderItem),
      note: `${BLOCKCHAIN_PROVIDERS.length} reviewed free blockchain API providers`,
    };
  },
});
