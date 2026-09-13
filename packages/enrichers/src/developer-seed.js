/**
 * The official CLIs of the hosts we know, read off each vendor's own install
 * guide.
 *
 * Every command here was found verbatim on the page `docs` names when the
 * table was written (2026-09-13), and `scripts/verify-developer-seed.js`
 * re-reads those pages and writes what it found to
 * packages/enrichers/test/fixtures/developer-seed-verified.json; the test
 * fails on any command the fixture does not carry. A command that stops
 * appearing on the vendor's page is a command we stop printing.
 *
 * Keyed by registrable domain, never by name: "Digital" must not find
 * "DigitalOcean". A vendor with no CLI is recorded as `cli: null` with the
 * date we looked, because "there is none" is worth knowing too.
 *
 * Two-step installs are written `a && b`; the verifier checks each half.
 */

const D = (domain, cli, extra = {}) => [domain, { domain, cli, ...extra }];

export const DEVELOPER_SEED = new Map([
  D(
    'vultr.com',
    {
      name: 'vultr-cli',
      repo: 'https://github.com/vultr/vultr-cli',
      docs: 'https://github.com/vultr/vultr-cli',
      install: {
        brew: 'brew install vultr/vultr-cli/vultr-cli',
        go: 'go install github.com/vultr/vultr-cli/v3@latest',
        pacman: 'pacman -S vultr-cli',
        dnf: 'dnf install vultr-cli',
      },
    },
    { terraform: 'vultr/vultr' },
  ),
  D(
    'linode.com',
    {
      name: 'linode-cli',
      repo: 'https://github.com/linode/linode-cli',
      docs: 'https://techdocs.akamai.com/cloud-computing/docs/install-and-configure-the-cli',
      install: { pip: 'pip3 install linode-cli --upgrade', pipx: 'pipx install linode-cli' },
    },
    { terraform: 'linode/linode' },
  ),
  D(
    'scaleway.com',
    {
      name: 'scw',
      repo: 'https://github.com/scaleway/scaleway-cli',
      docs: 'https://github.com/scaleway/scaleway-cli',
      install: {
        brew: 'brew install scw',
        go: 'go install github.com/scaleway/scaleway-cli/v2/cmd/scw@latest',
        curl: 'curl -s https://raw.githubusercontent.com/scaleway/scaleway-cli/main/scripts/get.sh | sh',
        pacman: 'pacman -S scaleway-cli',
        choco: 'choco install scaleway-cli',
      },
    },
    { terraform: 'scaleway/scaleway' },
  ),
  D(
    'ovhcloud.com',
    {
      name: 'ovhcloud',
      repo: 'https://github.com/ovh/ovhcloud-cli',
      docs: 'https://github.com/ovh/ovhcloud-cli',
      install: {
        brew: 'brew install --cask ovh/tap/ovhcloud-cli',
        go: 'go install github.com/ovh/ovhcloud-cli/cmd/ovhcloud@latest',
        curl: 'curl -fsSL https://raw.githubusercontent.com/ovh/ovhcloud-cli/main/install.sh | sh',
      },
    },
    { terraform: 'ovh/ovh', aliases: ['ovh.com'] },
  ),
  D(
    'hetzner.com',
    {
      name: 'hcloud',
      repo: 'https://github.com/hetznercloud/cli',
      docs: 'https://github.com/hetznercloud/cli/blob/main/docs/tutorials/setup-hcloud-cli.md',
      install: {
        brew: 'brew install hcloud',
        go: 'go install github.com/hetznercloud/cli/cmd/hcloud@latest',
        winget: 'winget install HetznerCloud.CLI',
        scoop: 'scoop install hcloud',
      },
    },
    { terraform: 'hetznercloud/hcloud', aliases: ['hetzner.cloud'] },
  ),
  D(
    'digitalocean.com',
    {
      name: 'doctl',
      repo: 'https://github.com/digitalocean/doctl',
      docs: 'https://docs.digitalocean.com/reference/doctl/how-to/install/',
      install: { brew: 'brew install doctl', snap: 'snap install doctl' },
    },
    { terraform: 'digitalocean/digitalocean' },
  ),
  D(
    'upcloud.com',
    {
      name: 'upctl',
      repo: 'https://github.com/UpCloudLtd/upcloud-cli',
      docs: 'https://github.com/UpCloudLtd/upcloud-cli/blob/main/docs/index.md',
      install: { brew: 'brew tap UpCloudLtd/tap && brew install upcloud-cli' },
    },
    { terraform: 'UpCloudLtd/upcloud' },
  ),
  D(
    'civo.com',
    {
      name: 'civo',
      repo: 'https://github.com/civo/cli',
      docs: 'https://github.com/civo/cli',
      install: {
        brew: 'brew tap civo/tools && brew install civo',
        curl: 'curl -sL https://civo.com/get | sh',
        choco: 'choco install civo-cli',
        scoop: 'scoop bucket add extras && scoop install civo',
      },
    },
    { terraform: 'civo/civo' },
  ),
  D(
    'exoscale.com',
    {
      name: 'exo',
      repo: 'https://github.com/exoscale/cli',
      docs: 'https://community.exoscale.com/tools/command-line-interface/',
      install: {
        brew: 'brew tap exoscale/tap && brew install exoscale-cli',
        scoop:
          'scoop bucket add exoscale-cli https://github.com/exoscale/cli && scoop install exoscale-cli',
      },
    },
    { terraform: 'exoscale/exoscale' },
  ),
  D(
    'fly.io',
    {
      name: 'flyctl',
      repo: 'https://github.com/superfly/flyctl',
      docs: 'https://fly.io/docs/flyctl/install/',
      install: { brew: 'brew install flyctl', curl: 'curl -L https://fly.io/install.sh | sh' },
    },
    { terraform: 'fly-apps/fly' },
  ),
  D(
    'railway.com',
    {
      name: 'railway',
      repo: 'https://github.com/railwayapp/cli',
      docs: 'https://docs.railway.com/guides/cli',
      install: {
        npm: 'npm i -g @railway/cli',
        brew: 'brew install railway',
        scoop: 'scoop install railway',
      },
    },
    { aliases: ['railway.app'] },
  ),
  D(
    'render.com',
    {
      name: 'render',
      repo: 'https://github.com/render-oss/cli',
      docs: 'https://render.com/docs/cli',
      install: {
        brew: 'brew install render',
        winget: 'winget install render.cli',
        curl: 'curl -fsSL https://raw.githubusercontent.com/render-oss/cli/refs/heads/main/bin/install.sh | sh',
      },
    },
    { terraform: 'render-oss/render' },
  ),
  D(
    'vercel.com',
    {
      name: 'vercel',
      repo: 'https://github.com/vercel/vercel',
      docs: 'https://vercel.com/docs/cli',
      install: { npm: 'npm i -g vercel', pnpm: 'pnpm i -g vercel' },
    },
    { terraform: 'vercel/vercel' },
  ),
  D(
    'netlify.com',
    {
      name: 'netlify',
      repo: 'https://github.com/netlify/cli',
      docs: 'https://docs.netlify.com/cli/get-started/',
      install: { npm: 'npm install -g netlify-cli' },
    },
    { terraform: 'netlify/netlify' },
  ),
  D(
    'cloudflare.com',
    {
      name: 'wrangler',
      repo: 'https://github.com/cloudflare/workers-sdk',
      docs: 'https://developers.cloudflare.com/workers/wrangler/install-and-update/',
      install: { npm: 'npm i -D wrangler@latest', pnpm: 'pnpm add -D wrangler@latest' },
    },
    { terraform: 'cloudflare/cloudflare' },
  ),
  D(
    'amazon.com',
    {
      name: 'aws',
      repo: 'https://github.com/aws/aws-cli',
      docs: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
      install: {
        curl: 'curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash',
        snap: 'snap install aws-cli --classic',
      },
    },
    { terraform: 'hashicorp/aws', aliases: ['aws.amazon.com'] },
  ),
  D(
    'google.com',
    {
      name: 'gcloud',
      repo: null,
      docs: 'https://cloud.google.com/sdk/docs/install',
      install: { apt: 'apt-get install google-cloud-cli' },
    },
    { terraform: 'hashicorp/google', aliases: ['cloud.google.com'] },
  ),
  D(
    'microsoft.com',
    {
      name: 'az',
      repo: 'https://github.com/Azure/azure-cli',
      docs: 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-macos',
      install: { brew: 'brew install azure-cli' },
    },
    { terraform: 'hashicorp/azurerm', aliases: ['azure.microsoft.com', 'azure.com'] },
  ),
  D(
    'oracle.com',
    {
      name: 'oci',
      repo: 'https://github.com/oracle/oci-cli',
      docs: 'https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm',
      install: {
        brew: 'brew install oci-cli',
        curl: 'bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"',
      },
    },
    { terraform: 'oracle/oci' },
  ),
  D(
    'ibm.com',
    {
      name: 'ibmcloud',
      repo: 'https://github.com/IBM-Cloud/ibm-cloud-cli-release',
      docs: 'https://cloud.ibm.com/docs/cli?topic=cli-install-ibmcloud-cli',
      install: { curl: 'curl -fsSL https://clis.cloud.ibm.com/install/linux | sh' },
    },
    { terraform: 'IBM-Cloud/ibm', aliases: ['cloud.ibm.com'] },
  ),
  D(
    'alibabacloud.com',
    {
      name: 'aliyun',
      repo: 'https://github.com/aliyun/aliyun-cli',
      docs: 'https://github.com/aliyun/aliyun-cli',
      install: { brew: 'brew install aliyun-cli' },
    },
    { terraform: 'aliyun/alicloud', aliases: ['aliyun.com'] },
  ),
  D(
    'tencentcloud.com',
    {
      name: 'tccli',
      repo: 'https://github.com/TencentCloud/tencentcloud-cli',
      docs: 'https://github.com/TencentCloud/tencentcloud-cli',
      install: {
        pip: 'pip install tccli',
        brew: 'brew tap tencentcloud/tccli && brew install tccli',
      },
    },
    { terraform: 'tencentcloudstack/tencentcloud', aliases: ['tencent.com'] },
  ),
  D(
    'backblaze.com',
    {
      name: 'b2',
      repo: 'https://github.com/Backblaze/B2_Command_Line_Tool',
      docs: 'https://github.com/Backblaze/B2_Command_Line_Tool',
      install: { pip: 'pip install b2', brew: 'brew install b2-tools' },
    },
    { terraform: 'Backblaze/b2' },
  ),
  D(
    'kamatera.com',
    {
      name: 'cloudcli',
      repo: 'https://github.com/cloudwm/cloudcli',
      docs: 'https://github.com/cloudwm/cloudcli',
      install: {},
      note: 'Prebuilt binaries on the releases page; no package manager.',
    },
    { terraform: 'Kamatera/kamatera' },
  ),
  D(
    'contabo.com',
    {
      name: 'cntb',
      repo: 'https://github.com/contabo/cntb',
      docs: 'https://github.com/contabo/cntb',
      install: {},
      note: 'Prebuilt binaries on the releases page; no package manager.',
    },
    { terraform: 'contabo/contabo' },
  ),
  D(
    'hostinger.com',
    {
      name: 'hostinger',
      repo: 'https://github.com/hostinger/api-cli',
      docs: 'https://github.com/hostinger/api-cli',
      install: { brew: 'brew install hostinger/tap/hostinger' },
    },
    { terraform: 'hostinger/hostinger' },
  ),
  D(
    'fastly.com',
    {
      name: 'fastly',
      repo: 'https://github.com/fastly/cli',
      docs: 'https://www.fastly.com/documentation/reference/tools/cli/',
      install: { brew: 'brew install fastly/tap/fastly', npm: 'npm install -g @fastly/cli@latest' },
    },
    { terraform: 'fastly/fastly' },
  ),
  D(
    'akamai.com',
    {
      name: 'akamai',
      repo: 'https://github.com/akamai/cli',
      docs: 'https://github.com/akamai/cli',
      install: { brew: 'brew install akamai' },
    },
    { terraform: 'akamai/akamai' },
  ),
  D(
    'equinix.com',
    {
      name: 'metal',
      repo: 'https://github.com/equinix/metal-cli',
      docs: 'https://github.com/equinix/metal-cli',
      install: {
        brew: 'brew tap equinix/homebrew-tap && brew install metal-cli',
        go: 'go install github.com/equinix/metal-cli/cmd/metal@latest',
      },
      note: 'Equinix Metal is being sunset; the CLI still installs.',
    },
    { terraform: 'equinix/equinix', aliases: ['metal.equinix.com', 'deploy.equinix.com'] },
  ),
  D(
    'latitude.sh',
    {
      name: 'lsh',
      repo: 'https://github.com/latitudesh/lsh',
      docs: 'https://github.com/latitudesh/lsh',
      install: {
        brew: 'brew install latitudesh/tools/lsh',
        curl: 'curl -fsSL https://cli.latitude.sh/install.sh | sh',
      },
    },
    { terraform: 'latitudesh/latitudesh' },
  ),
  D(
    'cherryservers.com',
    {
      name: 'cherryctl',
      repo: 'https://github.com/cherryservers/cherryctl',
      docs: 'https://github.com/cherryservers/cherryctl',
      install: {
        brew: 'brew tap cherryservers/cherryctl && brew install cherryctl',
        go: 'go install github.com/cherryservers/cherryctl@latest',
      },
    },
    { terraform: 'cherryservers/cherryservers' },
  ),
  D(
    'gandi.net',
    {
      name: 'gandi',
      repo: 'https://github.com/Gandi/gandi.cli',
      docs: 'https://github.com/Gandi/gandi.cli',
      install: { pip: 'pip install gandi.cli' },
    },
    { terraform: 'go-gandi/gandi' },
  ),
  D('pantheon.io', {
    name: 'terminus',
    repo: 'https://github.com/pantheon-systems/terminus',
    docs: 'https://github.com/pantheon-systems/terminus',
    install: { brew: 'brew install pantheon-systems/external/terminus' },
  }),
  D('platform.sh', {
    name: 'platform',
    repo: 'https://github.com/platformsh/cli',
    docs: 'https://github.com/platformsh/cli',
    install: {
      curl: 'curl -fsSL https://raw.githubusercontent.com/platformsh/cli/main/installer.sh | bash',
    },
  }),
  D('upsun.com', {
    name: 'upsun',
    repo: 'https://github.com/upsun/cli',
    docs: 'https://github.com/upsun/cli',
    install: {
      brew: 'brew install upsun/tap/upsun-cli',
      curl: 'curl -fsSL https://raw.githubusercontent.com/upsun/cli/main/installer.sh | bash',
      scoop:
        'scoop bucket add upsun https://github.com/upsun/homebrew-tap.git && scoop install upsun',
      nix: 'nix profile install nixpkgs#upsun',
    },
  }),
  D(
    'heroku.com',
    {
      name: 'heroku',
      repo: 'https://github.com/heroku/cli',
      docs: 'https://devcenter.heroku.com/articles/heroku-cli',
      install: {
        brew: 'brew install heroku/brew/heroku',
        curl: 'curl https://cli-assets.heroku.com/install.sh | sh',
        npm: 'npm install -g heroku',
      },
    },
    { terraform: 'heroku/heroku' },
  ),
  D(
    'koyeb.com',
    {
      name: 'koyeb',
      repo: 'https://github.com/koyeb/koyeb-cli',
      docs: 'https://github.com/koyeb/koyeb-cli',
      install: {
        brew: 'brew install koyeb/tap/koyeb',
        go: 'go install github.com/koyeb/koyeb-cli/cmd/koyeb',
      },
    },
    { terraform: 'koyeb/koyeb' },
  ),
  D('northflank.com', {
    name: 'northflank',
    repo: null,
    docs: 'https://northflank.com/docs/v1/api/use-the-cli',
    install: { npm: 'npm i -g @northflank/cli' },
  }),
  D(
    'qovery.com',
    {
      name: 'qovery',
      repo: 'https://github.com/Qovery/qovery-cli',
      docs: 'https://github.com/Qovery/qovery-cli',
      install: {
        curl: 'curl -s https://get.qovery.com | bash',
        brew: 'brew tap Qovery/qovery-cli && brew install qovery-cli',
        scoop:
          'scoop bucket add qovery https://github.com/Qovery/scoop-qovery-cli && scoop install qovery-cli',
      },
    },
    { terraform: 'qovery/qovery' },
  ),
  D('bunny.net', {
    name: 'bunny',
    repo: 'https://github.com/BunnyWay/cli',
    docs: 'https://github.com/BunnyWay/cli',
    install: {
      curl: 'curl -fsSL https://cli.bunny.net/install.sh | sh',
      npm: 'npm install -g @bunny.net/cli',
    },
  }),
  D(
    'servers.com',
    {
      name: 'srvctl',
      repo: 'https://github.com/serverscom/srvctl',
      docs: 'https://github.com/serverscom/srvctl',
      install: { brew: 'brew tap serverscom/serverscom && brew install srvctl' },
    },
    { terraform: 'serverscom/serverscom' },
  ),
  D(
    'leaseweb.com',
    {
      name: 'leaseweb',
      repo: 'https://github.com/leaseweb/leaseweb-cli',
      docs: 'https://github.com/leaseweb/leaseweb-cli',
      install: {},
      deprecated: true,
      note: 'The repository says it is no longer maintained; built from source with go build.',
    },
    { terraform: 'LeaseWeb/leaseweb' },
  ),
  D('liquidweb.com', {
    name: 'lw-cli',
    repo: 'https://github.com/liquidweb/liquidweb-cli',
    docs: 'https://github.com/liquidweb/liquidweb-cli',
    install: {},
    note: 'Prebuilt binaries on the releases page, or go install from the checkout.',
  }),
  D('fortrabbit.com', {
    name: 'frbit',
    repo: 'https://github.com/fortrabbit/frbit-cli',
    docs: 'https://github.com/fortrabbit/frbit-cli',
    install: {
      curl: 'curl -fsSL https://github.com/fortrabbit/frbit-cli/releases/latest/download/install.sh | sh',
    },
  }),
  D('coolify.io', {
    name: 'coolify',
    repo: 'https://github.com/coollabsio/coolify-cli',
    docs: 'https://github.com/coollabsio/coolify-cli',
    install: {
      curl: 'curl -fsSL https://raw.githubusercontent.com/coollabsio/coolify-cli/main/scripts/install.sh | bash',
      brew: 'brew install coollabsio/coolify-cli/coolify-cli',
      go: 'go install github.com/coollabsio/coolify-cli/coolify@latest',
    },
  }),
  D('godaddy.com', {
    name: 'godaddy',
    repo: 'https://github.com/godaddy/cli',
    docs: 'https://github.com/godaddy/cli',
    install: {
      curl: 'curl -fsSL https://github.com/godaddy/cli/releases/latest/download/install.sh | bash',
    },
  }),
  // Looked, found none. The date is the point of the record.
  D('hivelocity.net', null, {
    terraform: 'hivelocity/hivelocity',
    apiDocs: 'https://developers.hivelocity.net/',
    checked: '2026-09-13',
  }),
  D('kinsta.com', null, {
    apiDocs: 'https://kinsta.com/docs/kinsta-api-intro/',
    checked: '2026-09-13',
  }),
  D('wpengine.com', null, { apiDocs: 'https://wpengineapi.com/', checked: '2026-09-13' }),
  D('infomaniak.com', null, {
    apiDocs: 'https://developer.infomaniak.com/',
    checked: '2026-09-13',
  }),
  D('namecheap.com', null, {
    apiDocs: 'https://www.namecheap.com/support/api/intro/',
    checked: '2026-09-13',
  }),
  D('wasabi.com', null, {
    apiDocs: 'https://docs.wasabi.com/docs/how-do-i-use-aws-cli-with-wasabi',
    checked: '2026-09-13',
    note: 'S3-compatible; the AWS CLI is the documented tool.',
  }),
  D('rackspace.com', null, {
    checked: '2026-09-13',
    note: 'The old rack CLI is retired; OpenStack tooling applies.',
  }),
]);

/** Every domain the seed answers for, aliases included. */
export const SEED_DOMAINS = new Map();
for (const [domain, row] of DEVELOPER_SEED) {
  SEED_DOMAINS.set(domain, row);
  for (const a of row.aliases ?? []) SEED_DOMAINS.set(a, row);
}
