CREATE TABLE transactions(
  id SERIAL PRIMARY KEY,
  universal_profile_address VARCHAR(100),
  nonce VARCHAR(100),
  signature TEXT,
  abi TEXT,
  channel_id INT,
  status VARCHAR(100),
  signer_address VARCHAR(100),
  hash VARCHAR(1000),
  relayer_nonce VARCHAR(100),
  relayer_address VARCHAR(100),
  estimated_gas INT,
  gas_used INT,
  approved_quota_id INT,
  FOREIGN KEY(universal_profile_address) REFERENCES universal_profiles(address),
  FOREIGN KEY(approved_quota_id) REFERENCES approved_quotas(id),
  UNIQUE (nonce, channel_id, signer_address)
);