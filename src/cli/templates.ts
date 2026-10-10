/** Starter configuration written by `media-migrate init`. Secrets are referenced by env var NAME only. */
export const MINIMAL_CONFIG = `{
  "version": 1,
  "environment": "staging",
  "source": {
    "storage": {
      "provider": "s3",
      "bucket": "my-bucket",
      "endpoint": "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
      "accessKeyIdEnv": "R2_ACCESS_KEY_ID",
      "secretAccessKeyEnv": "R2_SECRET_ACCESS_KEY"
    },
    "legacyHosts": ["cdn.example.com"]
  },
  "database": {
    "provider": "mongodb",
    "uriEnv": "MONGODB_URI",
    "database": "app",
    "collections": [
      { "name": "products", "fields": ["photo", "photos[]"] }
    ]
  },
  "destination": {
    "storage": {
      "provider": "s3",
      "bucket": "my-bucket",
      "endpoint": "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
      "accessKeyIdEnv": "R2_ACCESS_KEY_ID",
      "secretAccessKeyEnv": "R2_SECRET_ACCESS_KEY"
    },
    "publicBaseUrl": "https://cdn.example.com",
    "referenceVariantWidth": 1200
  }
}
`;
