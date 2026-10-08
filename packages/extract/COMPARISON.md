# Extraction Comparison

The extraction corpus is compared against frozen behaviors from these local checkouts:

- Firecrawl `556c12c9d293bc7392feb008946944d54068d04c`
- CRW `43b11f717b45cf854ce965d3bf5ed0c436a51fd6`

## Coverage

| Case                          | Firecrawl                  | CRW                           | Buncrawl result                                            |
| ----------------------------- | -------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Basic paragraphs and emphasis | Exact output fixture       | Equivalent converter coverage | Exact Firecrawl parity                                     |
| Lists                         | Exact output fixture       | Article fixture               | Structure retained                                         |
| Malformed HTML                | Four exact output fixtures | Cleanup tests                 | Exact Firecrawl parity                                     |
| Article chrome removal        | Selector cleanup           | `blog_article.html`           | Article retained; header, aside, and footer removed        |
| Documentation TOC removal     | Selector cleanup           | `docs_toc.html`               | Documentation retained; TOC removed                        |
| Relative article links        | Absolutized during cleanup | Absolutized during extraction | Absolutized during cleanup                                 |
| Code blocks                   | Fenced by converter        | Fenced by converter           | Fenced, with longer fences when content contains backticks |

## Method

Exact assertions are used for Firecrawl's published HTML-to-Markdown unit cases. Full-page extraction is compared semantically because each project has intentional whitespace, list indentation, title recovery, and cleanup differences. Semantic cases assert required headings, prose, lists, code, and links, as well as page chrome that must be absent.

The copied fixtures are reduced versions of the upstream samples. Their source paths and commits are recorded in `test/comparison.test.ts`, making updates reviewable when either reference implementation changes.

## Intentional Differences

- Buncrawl uses Mozilla Readability as a conservative fallback after deterministic cleanup. Firecrawl primarily removes known unwanted selectors; CRW uses its own candidate scoring and quality fallback.
- Buncrawl preserves short useful pages when Readability does not meet its content threshold.
- Buncrawl selects a code fence longer than any backtick run in the source code, avoiding invalid nested fences.
- Comparisons do not require byte-identical whitespace or ordered-list indentation across converter libraries.
