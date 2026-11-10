import { assert, test } from 'orca/testing'
import { JSDOM } from 'jsdom'
import { findMatches, highlightMatches, SearchNavigation } from './search'

test('search is literal and preserves UTF-16 offsets and repeated matches', () => {
  assert.deepEqual(findMatches('a.b A.B axb', 'a.b'), [{ start: 0, end: 3 }, { start: 4, end: 7 }])
  assert.deepEqual(findMatches('😀 error error', 'error', 1), [{ start: 3, end: 8 }])
  assert.deepEqual(findMatches('text', ''), [])
})

test('a match spanning coloured/link text remains one navigable match and opens its trace', () => {
  const dom = new JSDOM('<div id="log"><details><summary data-search-ignore>error label</summary><span id="message"><b>er</b><a href="#">ror</a> then ERROR</span></details></div>')
  const root = dom.window.document.getElementById('log')!
  const anchor = root.querySelector('a')!
  let clicked = false
  anchor.addEventListener('click', () => { clicked = true })
  highlightMatches(root, 'error', 10)
  const navigation = new SearchNavigation()
  navigation.refresh(root)
  assert.equal(navigation.count, 2)
  assert.equal(root.querySelectorAll('.search-hit').length, 3)
  anchor.click()
  assert.equal(clicked, true)
  navigation.move(1)
  assert.equal(root.querySelector('details')!.open, true)
  assert.equal(root.querySelector('.current-match')!.textContent, 'ERROR')
  dom.window.close()
})
