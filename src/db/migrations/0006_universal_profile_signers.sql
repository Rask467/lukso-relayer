CREATE TABLE universal_profile_signers(
  id SERIAL PRIMARY KEY,
  universal_profile_address VARCHAR(100),
  signer_address VARCHAR(100),
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  FOREIGN KEY(universal_profile_address) REFERENCES universal_profiles(address),
  FOREIGN KEY(signer_address) REFERENCES signers(address)
  );