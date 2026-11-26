import { useMemo } from 'react'
import type { Comparison } from './api'

type Point = [number, number]

// The aligned grid is uniform in distance, but its nearest recorded XY fixes
// can repeat or bunch up. Redistribute travel locally along the original
// polyline. Work in arc length so smoothing cannot cut across a corner.
function playbackPath(path: (number[] | null)[]) {
  const arc = new Float64Array(path.length)
  const travel = new Float64Array(path.length)
  for (let start = 0; start < path.length;) {
    if (!path[start]) { start++; continue }
    let end = start
    while (end + 1 < path.length && path[end + 1]) {
      const a = path[end]!, b = path[end + 1]!
      arc[end + 1] = arc[end] + Math.hypot(b[0]-a[0], b[1]-a[1])
      end++
    }
    for (let i=start; i<=end; i++) {
      travel[i] = i===start || i===end ? arc[i] :
        (arc[Math.max(start,i-2)] + 4*arc[i-1] + 6*arc[i] + 4*arc[i+1] + arc[Math.min(end,i+2)]) / 16
    }
    start = end + 1
  }
  return (index: number) => {
    const i = Math.floor(index), j = Math.ceil(index)
    if (!path[i] || !path[j]) return null
    const distance = travel[i] + (travel[j]-travel[i])*(index-i)
    let k = i
    while (k>0 && path[k-1] && arc[k]>distance) k--
    while (path[k+1] && arc[k+1]<=distance) k++
    if (!path[k+1] || arc[k]>=distance) return path[k]
    return markerPoint(path,k+(distance-arc[k])/(arc[k+1]-arc[k]))
  }
}
export function useLapMap(series: Comparison['estimated']['series']) {
  return useMemo(()=>{
    const ref=series.reference.positions ?? [], cmp=series.compare.positions ?? []
    const valid=(p:Point|null):p is Point=>p!==null && p.every(Number.isFinite)
    const all=[...ref,...cmp].filter(valid)
    if(all.length<3) return null
    const xs=all.map(p=>p[0]), ys=all.map(p=>p[1])
    const left=Math.min(...xs), right=Math.max(...xs), top=Math.max(...ys), bottom=Math.min(...ys)
    if(right===left || top===bottom) return null
    const scale=Math.min(156/(right-left),90/(top-bottom))
    const project=(p:Point|null)=>p && valid(p) ? [90+(p[0]-(left+right)/2)*scale,55-(p[1]-(top+bottom)/2)*scale] : null
    const reference=ref.map(project), compare=cmp.map(project)
    const points:number[][]=[], breaks=new Set<number>()
    let gap=true
    for(let i=0;i<Math.max(ref.length,cmp.length);i++){
      const p=reference[i] ?? compare[i]
      if(!p){gap=true;continue}
      if(gap) breaks.add(points.length)
      points.push(p); gap=false
    }
    return {reference,compare,playback:[playbackPath(reference), playbackPath(compare)],points,breaks,path:points.map((p,i)=>(breaks.has(i)?'M':'L')+p.join(' ')).join(' ')}
  },[series])
}
export type LapMap = NonNullable<ReturnType<typeof useLapMap>>

// Fractional indices are render coordinates only. Exact times select exact vertices.
export function markerIndex(times: number[], t: number, first: number, last: number) {
  if (t <= times[first]) return first
  if (t >= times[last]) return last
  let low=first, high=last
  while (high-low>1) {
    const mid=(low+high) >>> 1
    if (times[mid] <= t) low=mid
    else high=mid
  }
  return low+(t-times[low])/(times[high]-times[low])
}

export function markerPoint(path: (number[] | null)[], index: number) {
  const left=Math.floor(index), a=path[left]
  if (left===index || !a) return a
  const b=path[left+1]
  if (!b) return null
  const f=index-left
  return [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f]
}
