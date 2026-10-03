/**
 * @lumalink/core/node
 * Node.js-specific platform adapters using native OpenSSL and node:crypto.
 */

import { NodeCryptoProvider, defaultNodeCryptoProvider } from './node-crypto-provider.js';
import { NodeHasher, nodeHasher } from './node-hasher.js';
import { setDefaultCryptoProvider } from '../../security/crypto-provider.js';
import { setDefaultHasher } from '../../transfer/hasher.js';

// Automatically register Node defaults when this subpath is imported
setDefaultCryptoProvider(defaultNodeCryptoProvider);
setDefaultHasher(nodeHasher);

export { NodeCryptoProvider, defaultNodeCryptoProvider, NodeHasher, nodeHasher };
