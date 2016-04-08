/**
 * Compute an isoline as a GeoJSON feature from a regular grid
 * Uses the Marching Squares algorithm, with code ported from
 * https://github.com/conveyal/r5/blob/master/src/main/java/com/conveyal/r5/analyst/IsochroneFeature.java
 * @author mattwigway
 */

import inside from 'turf-inside'
import point from 'turf-point'
import dbg from 'debug'

const debug = dbg('jsolines')

/**
 * Create a JSON isoline. Surface is a (possibly typed) array, width and height are its width and height, and cutoff is the cutoff.
 * It is possible to disable linear interpolation for debug purposes by passing interpolation: false
 */
export default function jsolines ({surface, width, height, cutoff, project, interpolation = true}) {
  // first, create the contour grid
  let contour = getContour({surface, width, height, cutoff})
  let cWidth = width - 1

  // javascript does not have boolean arrays. lame.
  let found = new Uint8Array((width - 1) * (height - 1))

  // DEBUG, comment out to save memory
  let indices = []

  // we'll sort out what shell goes with what hole in a bit
  let shells = []
  let holes = []

  // find a cell that has a line in it, then follow that line, keeping filled area to your
  // left. This lets us use winding direction to determine holes.
  for (let origy = 0; origy < height - 1; origy++) {
    for (let origx = 0; origx < width - 1; origx++) {
      if (found[origy * cWidth + origx] === 1) {
        continue
      }

      let idx = contour[origy * cWidth + origx]
      // continue if there is no line here or if it's a saddle, as we don't know which way the saddle goes
      if (idx === 0 || idx === 5 || idx === 10 || idx === 15) continue

      // huzzah! we have found a line, now follow it, keeping the filled area to our left,
      // which allows us to use the winding direction to determine what should be a shell and
      // what should be a hole
      let x = origx
      let y = origy

      let prevx = -1
      let prevy = -1
      let startx = -1
      let starty = -1

      // track winding direction
      let direction = 0

      let coords = []

      RING: while (true) {
        // make sure we're not traveling in circles
        // NB using index from _previous_ cell, we have not yet set an index for this cell
        if (found[y * cWidth + x] === 1) {
          console.log(`Ring crosses other ring (or possibly self) at ${x}, ${y} coming from case ${idx}`)
          console.log(`Last few indices: ${indices.slice(Math.max(0, indices.length - 10))}`)
          break RING
        }

        prevx = startx
        prevy = starty
        startx = x
        starty = y
        idx = contour[y * cWidth + x]

        indices.push(idx)

        // only mark as found if it's not a saddle because we expect to reach saddles twice.
        if (idx !== 5 && idx !== 10) {
          found[y * cWidth + x] = 1
        }

        // follow the loop
        // we keep track of which contour cell we're in, and we always keep the filled area to our left.
        // thus we always indicate only which direction we exit the cell.
        switch (idx) {
          case 0:
            console.log('Ran off outside of ring')
            break RING
          case 1:
            x--
            break
          // NB: +y is down
          case 2:
            y++
            break
          case 3:
            x--
            break
          case 4:
            x++
            break
          case 5:
            // assume that saddle has // orientation (as opposed to \\). It doesn't
            // really matter if we're wrong, we'll just have two disjoint pieces where we should have
            // one, or vice versa
            if (prevy > y) {
              // came from bottom
              x++
            } else if (prevy < y) {
              // came from top
              x--
            } else {
              console.log('Entered case 5 saddle point from wrong direction!')
            }
            break
          case 6:
            y++
            break
          case 7:
            x--
            break
          case 8:
            y--
            break
          case 9:
            y--
            break
          case 10: // hex a
            if (prevx < x) {
              // came from left
              y++
            } else if (prevx > x) {
              // came from right
              y--
            } else {
              console.log('Entered case 10 saddle point from wrong direction.')
            }
            break
          case 11: // b
            y--
            break
          case 12: // c
            x++
            break
          case 13: // d
            x++
            break
          case 14: // e
            y++
            break
          case 15: // f
            console.log('Ran off inside of ring')
            break RING
        }

        // keep track of winding direction
        direction += (x - startx) * (y + starty)

        let topLeft = surface[y * width + x]
        let topRight = surface[y * width + x + 1]
        let botLeft = surface[(y + 1) * width + x]
        let botRight = surface[(y + 1) * width + x + 1]

        // do linear interpolation
        let coord
        if (startx < x) {
          // came from left
          let frac = interpolation ? (cutoff - topLeft) / (botLeft - topLeft) : 0.5

          if (frac === Infinity) {
            debug(`segment fraction from left is Infinity at ${x}, ${y}; if this is at the edge of the query this is not totally unexpected.`)
            frac = 0.5
          }

          coord = [x, y + frac]
        } else if (startx > x) {
          // came from right
          let frac = interpolation ? (cutoff - topRight) / (botRight - topRight) : 0.5

          if (frac === Infinity) {
            debug(`segment fraction from right is Infinity at ${x}, ${y}; if this is at the edge of the query this is not totally unexpected.`)
            frac = 0.5
          }

          coord = [x + 1, y + frac]
        } else if (starty > y) {
          // came from bottom
          let frac = interpolation ? (cutoff - botLeft) / (botRight - botLeft) : 0.5

          if (frac === Infinity) {
            debug(`segment fraction from bottom is Infinity at ${x}, ${y}; if this is at the edge of the query this is not totally unexpected.`)
            frac = 0.5
          }

          coord = [x + frac, y + 1]
        } else if (starty < y) {
          // came from top
          let frac = interpolation ? (cutoff - topLeft) / (topRight - topLeft) : 0.5

          if (frac === Infinity) {
            debug(`segment fraction from top is Infinity at ${x}, ${y}; if this is at the edge of the query this is not totally unexpected.`)
            frac = 0.5
          }

          coord = [x + frac, y]
        } else {
          console.log(`Unexpected coordinate shift from ${startx}, ${starty} to ${x}, ${y}, discarding ring`)
          break RING
        }

        coords.push(project(coord))

        if (coords.length > 10000) {
          console.log('More than 10000 coordinates found in ring, skipping this ring')
          break RING
        }

        // we're back at the start of the ring
        if (x === origx && y === origy) {
          coords.push(coords[0]) // close the ring

          // make it a fully-fledged GeoJSON object
          let geom = {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [coords]
            }
          }

          // check winding direction
          // positive means counter clockwise, see http://stackoverflow.com/questions/1165647
          // NB +y is down so the signs are reversed from what would normally be expected
          if (direction > 0) shells.push(geom)
          else holes.push(geom)
          break RING
        }
      }
    }
  }

  // shell game time.
  // sort out shells and holes
  HOLES: for (let hole of holes) {
    for (let shell of shells) {
      // NB this is checking whether the first coordinate of the hole is inside the shell.
      // This is sufficient as shells don't overlap, and holes are guaranteed to be completely
      // contained by a single shell.
      if (inside(point(hole.geometry.coordinates[0][0]), shell)) {
        shell.geometry.coordinates.push(hole.geometry.coordinates[0])
        continue HOLES
      }
    }

    console.log('Did not find fitting shell for hole')
  }

  return {
    type: 'Feature',
    geometry: {
      type: 'MultiPolygon',
      coordinates: shells.map(s => s.geometry.coordinates)
    }
  }
}

/** Get a contouring grid. Exported for debug purposes, not generally used outside jsolines testing */
export function getContour ({surface, width, height, cutoff}) {
  let contour = new Uint8Array((width - 1) * (height - 1))

  // compute contour values for each cell
  for (let x = 0; x < width - 1; x++) {
    for (let y = 0; y < height - 1; y++) {
      let topLeft = surface[y * width + x] < cutoff
      let topRight = surface[y * width + x + 1] < cutoff
      let botLeft = surface[(y + 1) * width + x] < cutoff
      let botRight = surface[(y + 1) * width + x + 1] < cutoff

      // if we're at the edge of the area, set the outer sides to false, so that isochrones always close
      // even when they actually extend beyond the edges of the surface
      if (x === 0) topLeft = botLeft = false
      if (x === width - 2) topRight = botRight = false
      if (y === 0) topLeft = topRight = false
      if (y === height - 2) botRight = botLeft = false

      let idx = 0

      if (topLeft) idx |= 1 << 3
      if (topRight) idx |= 1 << 2
      if (botRight) idx |= 1 << 1
      if (botLeft) idx |= 1

      contour[y * (width - 1) + x] = idx
    }
  }

  return contour
}
