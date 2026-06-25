import { createContext } from 'react'

// Shared search state so any tree node (TalentNode, HeatmapNode) can dim/emphasise
// itself without threading props through TreePanel / SideBySideDiff / Heatmap. The
// search box (in MainView) is the single provider.
//
//   active   — true while there is a non-empty query
//   matchIds — Set<number> of node ids that match (empty when inactive)
export const SearchContext = createContext({ active: false, matchIds: null })
