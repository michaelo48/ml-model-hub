import { describe, expect, it } from 'vitest'
import { CsvParser, parseCsv, parseCsvBytes } from '../src/csv'

describe('CsvParser', () => {
  it('parses simple rows with LF, CRLF and no trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('handles quotes, escaped quotes, embedded delimiters and newlines', () => {
    expect(parseCsv('"x, y","he said ""hi"""\n"multi\nline",z')).toEqual([
      ['x, y', 'he said "hi"'],
      ['multi\nline', 'z'],
    ])
  })

  it('keeps empty fields and skips blank lines', () => {
    expect(parseCsv('a,,c\n\n,,\n\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ])
  })

  it('strips a UTF-8 BOM', () => {
    expect(parseCsv('\uFEFFa,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('produces identical output for every chunk boundary', () => {
    const text = 'name,q\r\n"a ""b"", c",1\n"line\r\nbreak",2\r\nplain,"3"\n'
    const expected = parseCsv(text)
    expect(expected).toEqual([
      ['name', 'q'],
      ['a "b", c', '1'],
      ['line\r\nbreak', '2'],
      ['plain', '3'],
    ])
    for (let cut = 1; cut < text.length; cut++) {
      const rows: string[][] = []
      const p = new CsvParser((r) => rows.push(r))
      p.push(text.slice(0, cut))
      p.push(text.slice(cut))
      p.end()
      expect(rows, `cut at ${cut}`).toEqual(expected)
    }
  })

  it('decodes bytes with multibyte characters split across chunks', () => {
    const text = 'ciudad,n\nMálaga,1\n東京,2\n'
    const bytes = new TextEncoder().encode(text)
    for (const chunk of [1, 2, 3, 5, 1024]) {
      const rows: string[][] = []
      parseCsvBytes(bytes, (r) => rows.push(r), chunk)
      expect(rows).toEqual([
        ['ciudad', 'n'],
        ['Málaga', '1'],
        ['東京', '2'],
      ])
    }
  })

  it('rejects malformed quoting with a row number', () => {
    expect(() => parseCsv('a,b\n"unterminated,1')).toThrow(/Row 2.*unterminated/)
    expect(() => parseCsv('a,b\nx"y,1')).toThrow(/Row 2.*unexpected quote/)
    expect(() => parseCsv('a,b\n"x"y,1')).toThrow(/Row 2.*after a closing quote/)
  })
})
