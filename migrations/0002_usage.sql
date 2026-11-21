-- Raw usage object from Qwen's finished task (token/duration counts), for cost estimates.
ALTER TABLE jobs ADD COLUMN usage TEXT;
