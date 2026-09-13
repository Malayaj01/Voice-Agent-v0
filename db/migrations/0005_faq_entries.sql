-- 0005 · faq_entries
-- ARCHITECTURE.md §7.3: off-script questions are answered by vector search over APPROVED
-- answers, spoken verbatim, then the flow returns to its anchor. Retrieval, never
-- generation. That is how general FAQs get added without giving up script control.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE faq_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    question        text    NOT NULL,
    -- Spoken verbatim. Nothing in the turn loop may paraphrase this.
    approved_answer text    NOT NULL,
    -- Dimension must match the embedding model; 768 is a placeholder pending the §11
    -- decision. Changing it is a migration, so settle the model first.
    embedding       vector(768),
    language        text    NOT NULL CHECK (language IN ('en-IN', 'hi-IN', 'hi-IN-hinglish')),
    active          boolean NOT NULL DEFAULT true
);

CREATE INDEX faq_active_lang_idx ON faq_entries (language) WHERE active;

-- Built once the table has rows; lists should be tuned to corpus size.
CREATE INDEX faq_embedding_idx ON faq_entries
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
