-- Standard one-person price in pounds, where the booking platform exposes it.
ALTER TABLE sessions ADD COLUMN price REAL;
