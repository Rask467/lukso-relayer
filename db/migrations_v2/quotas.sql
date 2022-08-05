CREATE TABLE quotas_v3(
  universal_profile_address VARCHAR(100) UNIQUE,
  monthly_gas INT,
  gas_used INT,
  estimated_gas_used INT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  FOREIGN KEY(universal_profile_address) REFERENCES universal_profiles_v3(address)
  );