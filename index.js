/**
 * Compute an isoline as a GeoJSON feature from a regular grid
 * Uses the Marching Squares algorithm, with code ported from
 * https://github.com/conveyal/r5/blob/master/src/main/java/com/conveyal/r5/analyst/IsochroneFeature.java
 * @author mattwigway
 */

import inside from 'turf-inside'
import point from 'turf-point'

/** Create a JSON isoline. Surface is a (possibly typed) array, width and height are its width and height, and cutoff is the cutoff */
export default function computeIsoline ({surface, width, height, cutoff, project}) {
  // first, create the contour grid
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
      if (botLeft) idx |= 1 << 1
      if (botRight) idx |= 1

      contour[y * (width - 1) + x] = idx
    }
  }

  let cWidth = width - 1

  // javascript does not have boolean arrays. lame.
  let found = new Uint8Array((width - 1) * (height - 1))

  // we'll sort out what shell goes with what hole in a bit
  let shells = []
  let holes = []

  // find a cell that has a line in it, then follow that line, keeping filled area to your
  // left. This lets us use winding direction to determine holes.
  for (let origy = 0; origy < height - 1; origy++) {
    for (let origx = 0; origx < width - 1; origx++) {
      if (found[origy * cWidth + origx]) continue

      let idx = contour[origy * cWidth + origx]
      // continue if there is no line here or if it's a saddle, as we don't know which way the saddle goes
      if (idx === 0 || idx === 5 || idx === 10 || idx === 15) continue

      // huzzah! we have found a line, now follow it, keeping the filled area to our left,
      // which allows us to use the winding direction to determing what should be a shell and
      // what should be a hole
      let x = origx
      let y = origy

      let prevx = -1
      let prevy = -1

      // track winding direction
      let direction = 0

      let coords = []

      while (true) {
        let startx = x
        let starty = y
        idx = contour[y * cWidth + x]

        if (idx === 0 || idx === 15) {
          console.log('Ran off outside of ring')
          break
        }

        // only mark as found if it's not a saddle because we expect to reach saddles twice.
        if (idx !== 5 && idx !== 10) found[y * cWidth + x] = 1

        // follow the loop
        switch (idx) {
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
          case 10:
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
          case 11:
            y--
            break
          case 12:
            x++
            break
          case 13:
            x++
            break
          case 14:
            y++
            break
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
          let frac = (cutoff - topLeft) / (botLeft - topLeft)
          coord = [x, y + frac]
        } else if (startx > x) {
          // came from right
          let frac = (cutoff - topRight) / (botRight - topRight)
          coord = [x + 1, y + frac]
        } else if (starty > y) {
          // came from bottom
          let frac = (cutoff - botLeft) / (botRight - botLeft)
          coord = [x + frac, y + 1]
        } else if (starty < y) {
          // came from top
          let frac = (cutoff - topLeft) / (topRight - topLeft)
          coord = [x + frac, y + 1]
        }

        coords.push(project(coord))

        // we're back at the start of the ring
        if (x === origx && y === origy) {
          coords.push(coords[0]) // close the ring
          break
        }

        // make it a fully-fledged GeoJSON object
        let geom = {
          type: 'Polygon',
          coordinates: [coords]
        }

        // check winding direction
        // positive means counter clockwise, see http://stackoverflow.com/questions/1165647
        // NB +y is down so the signs are reverse from what would normally be expected
        if (direction > 0) shells.add(geom)
        else holes.add(geom)
      }
    }
  }

  // shell game time.
  // sort out shells and holes
  holes.forEach(hole => {
    const holePoint = point(hole.coordinates[0][0])
    // NB this is checking whether the first coordinate of the hole is inside the shell.
    // This is sufficient as shells don't overlap, and holes are guaranteed to be completely
    // contained by a single shell.
    const containingShell = shells.find(shell => inside(holePoint, shell))

    if (containingShell) {
      containingShell.coordinates.push(hole.coordinates)
    } else {
      console.log('Did not find fitting shell for hole')
    }
  })

  return {
    type: 'MultiPolygon',
    coordinates: shells.map(s => s.coordinates)
  }
}
