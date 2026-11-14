# v0 empty mistakes database

This fixture contains a valid, empty SQLite `mistakes.db` with no migration
history. It represents the earliest supported database baseline.

The release migration gate verifies two production behaviors against it:

- upgrade mode creates and migrates all four managed databases to their latest
  versions through `MigrationCoordinator::run_all`;
- fault mode corrupts the SQLite database and requires the coordinator to
  surface a failure instead of reporting a false success.

The fixture is synthetic and contains no user data.
